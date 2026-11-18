const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize Database Tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dark_stores (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        store_id TEXT,
        sku VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        unit_label VARCHAR(50),
        mrp NUMERIC(10,2),
        selling_price NUMERIC(10,2),
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(50),
        delivery_address TEXT,
        items JSONB,
        total_amount NUMERIC(10,2),
        status VARCHAR(50) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure store_id column is TEXT even if table existed previously with INT or UUID
    await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id TEXT;');
    await pool.query('ALTER TABLE products ALTER COLUMN store_id TYPE TEXT USING store_id::TEXT;');

    console.log('Database tables verified/initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDB();

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// --- API ROUTES ---

// 1. Get all active stores
app.get('/api/stores', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dark_stores WHERE is_active = true');
    res.json({ success: true, stores: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Get products (optionally filtered by store_id)
app.get('/api/products', async (req, res) => {
  try {
    const { store_id } = req.query;
    let query = 'SELECT * FROM products';
    let params = [];
    if (store_id) {
      query += ' WHERE store_id = $1';
      params.push(String(store_id));
    }
    const result = await pool.query(query, params);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Place a new order
app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, customer_phone, delivery_address, items, total_amount } = req.body;
    const result = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, delivery_address, items, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, 'Pending') RETURNING *`,
      [customer_name, customer_phone, delivery_address, JSON.stringify(items), total_amount]
    );
    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Get all orders (for Admin Dashboard)
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Update order status
app.patch('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Automatic Cloud Store & Product Sync Endpoint
app.post('/api/sync-cloud', async (req, res) => {
  const { feed_url } = req.body;
  if (!feed_url) {
    return res.status(400).json({ success: false, error: 'Please provide a valid Cloud JSON URL' });
  }

  try {
    const response = await fetch(feed_url);
    const data = await response.json();

    if (!data.stores || !Array.isArray(data.stores)) {
      return res.status(400).json({ success: false, error: 'Invalid JSON format: missing "stores" array' });
    }

    // Ensure required columns exist and support TEXT store IDs
    await pool.query('ALTER TABLE dark_stores ADD COLUMN IF NOT EXISTS city VARCHAR(100);');
    await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id TEXT;');
    await pool.query('ALTER TABLE products ALTER COLUMN store_id TYPE TEXT USING store_id::TEXT;');
    await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_label VARCHAR(50);');
    await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100);');
    await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku);');

    let syncedStoresCount = 0;
    let syncedProductsCount = 0;

    for (const store of data.stores) {
      // Insert or update store
      let storeResult = await pool.query(
        'SELECT id FROM dark_stores WHERE name = $1 AND address = $2 LIMIT 1',
        [store.name, store.address]
      );

      let storeId;
      if (storeResult.rows.length > 0) {
        storeId = String(storeResult.rows[0].id);
        await pool.query(
          'UPDATE dark_stores SET city = $1, is_active = true WHERE id = $2',
          [store.city || '', storeResult.rows[0].id]
        );
      } else {
        const newStore = await pool.query(
          'INSERT INTO dark_stores (name, address, city, is_active) VALUES ($1, $2, $3, true) RETURNING id',
          [store.name, store.address, store.city || '']
        );
        storeId = String(newStore.rows[0].id);
      }
      syncedStoresCount++;

      // Insert products for this store
      if (store.products && Array.isArray(store.products)) {
        for (const prod of store.products) {
          await pool.query(`
            INSERT INTO products (store_id, sku, name, category, unit_label, mrp, selling_price, image_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (sku)
            DO UPDATE SET 
              store_id = EXCLUDED.store_id, 
              name = EXCLUDED.name, 
              category = EXCLUDED.category,
              unit_label = EXCLUDED.unit_label, 
              mrp = EXCLUDED.mrp, 
              selling_price = EXCLUDED.selling_price,
              image_url = EXCLUDED.image_url
          `, [
            storeId,
            prod.sku,
            prod.name,
            prod.category || 'General',
            prod.unit_label || '1 Pc',
            prod.mrp || 0,
            prod.selling_price || 0,
            prod.image_url || ''
          ]);
          syncedProductsCount++;
        }
      }
    }

    res.json({
      success: true,
      message: `Synced ${syncedStoresCount} store(s) and ${syncedProductsCount} product(s) from cloud!`
    });
  } catch (err) {
    console.error('Cloud Sync Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Anokhi server running on port ${PORT}`);
});

 

