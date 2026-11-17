const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PATCH"] }
});

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static('public'));


app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// --- API ROUTES ---

// Get all dark stores
app.get('/api/stores', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dark_stores WHERE is_active = true');
    res.json({ success: true, stores: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all products (with store name)
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, s.name AS store_name 
      FROM products p 
      LEFT JOIN dark_stores s ON p.store_id = s.id
      ORDER BY p.id DESC
    `);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save a new store
app.post('/api/stores', async (req, res) => {
  const { name, address, city } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO dark_stores (name, address, city, is_active)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [name, address, city]
    );
    res.status(201).json({ success: true, store: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save a new product under a specific store
app.post('/api/products', async (req, res) => {
  const { store_id, sku, name, category, unit_label, mrp, selling_price, image_url } = req.body;
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id INTEGER;`);
    const result = await pool.query(
      `INSERT INTO products (store_id, sku, name, category, unit_label, mrp, selling_price, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [store_id, sku, name, category, unit_label, mrp, selling_price, image_url]
    );
    res.status(201).json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// Place a new customer order (Cash on Delivery)
app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_phone, delivery_address, items, total_amount } = req.body;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(100) NOT NULL,
        customer_phone VARCHAR(20) NOT NULL,
        delivery_address TEXT NOT NULL,
        items JSONB NOT NULL,
        total_amount NUMERIC(10, 2) NOT NULL,
        status VARCHAR(30) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const result = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, delivery_address, items, total_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [customer_name, customer_phone, delivery_address, JSON.stringify(items), total_amount]
    );
    res.status(201).json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all orders (for your Admin Panel)
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM orders ORDER BY id DESC`);
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// --- AUTO-CREATE TABLES ON BOOT ---
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dark_stores (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(100) NOT NULL,
          address TEXT NOT NULL,
          delivery_radius_meters INT DEFAULT 3000,
          fssai_license VARCHAR(20),
          gstin VARCHAR(15),
          is_active BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS products (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          sku VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(150) NOT NULL,
          category VARCHAR(80) NOT NULL,
          unit_label VARCHAR(40) NOT NULL,
          mrp NUMERIC(10, 2) NOT NULL,
          selling_price NUMERIC(10, 2) NOT NULL,
          image_url TEXT
      );

      CREATE TABLE IF NOT EXISTS store_inventory (
          store_id UUID REFERENCES dark_stores(id),
          product_id UUID REFERENCES products(id),
          available_stock INT NOT NULL DEFAULT 100,
          PRIMARY KEY (store_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS orders (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_number VARCHAR(20) UNIQUE NOT NULL,
          customer_id VARCHAR(100),
          store_id UUID REFERENCES dark_stores(id),
          delivery_address TEXT NOT NULL,
          status VARCHAR(30) DEFAULT 'PLACED',
          payment_method VARCHAR(20) NOT NULL,
          grand_total NUMERIC(10, 2) NOT NULL,
          tip_amount NUMERIC(10, 2) DEFAULT 0,
          handover_otp VARCHAR(4) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("Database tables verified/created successfully.");
  } catch (err) {
    console.error("Error creating database tables:", err.message);
  }
}

// --- 1. SERVICEABILITY & GEOFENCING API ---
app.get('/api/v1/stores/serviceability', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Latitude and longitude are required' });

  try {
    const query = `
      SELECT id, name, address, delivery_radius_meters
      FROM dark_stores
      WHERE is_active = TRUE
      LIMIT 1;
    `;
    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ serviceable: false, message: 'No dark stores nearby.' });
    }

    const store = result.rows[0];
    res.json({ serviceable: true, storeId: store.id, storeName: store.name, etaMinutes: 8 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 2. SOCKET.IO RIDER & STORE TRACKING ---
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join:store_room', (storeId) => socket.join(`store:${storeId}`));
  socket.on('join:order_room', (orderId) => socket.join(`order:${orderId}`));

  socket.on('rider:location_update', (data) => {
    const { orderId, lat, lng, heading } = data;
    io.to(`order:${orderId}`).emit('order:rider_moved', { lat, lng, heading });
  });

  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Initialize database tables on startup, then launch server
initializeDatabase().then(() => {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => console.log(`Quick-commerce production backend running on port ${PORT}`));
});
