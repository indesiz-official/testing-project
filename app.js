// app.js

const express = require('express');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
require('dotenv').config();

const { Pool } = require('pg');

const app = express();

// ========== 数据库连接 ==========

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false  // 如果在 Render 或内部部署，不需要 SSL
});

// 测试连接
pool.connect()
  .then(client => {
    console.log('✅ PostgreSQL Connected!');
    client.release();
  })
  .catch(err => {
    console.error('❌ PostgreSQL connection error', err.stack);
  });

// ========== 中间件 ==========

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());  // 用于处理 application/json
app.use(session({
  secret: 'mysecret',
  resave: false,
  saveUninitialized: true
}));
app.use(cookieParser());

// 把 session 里的 username / cartCount 传入模板
app.use((req, res, next) => {
  res.locals.username = req.session.username || null;
  res.locals.cartCount = req.session.cart
    ? req.session.cart.reduce((sum, item) => sum + item.quantity, 0)
    : 0;
  next();
});

// “记住用户” cookie 中间件 （改为使用 pool.query）
app.use((req, res, next) => {
  if (!req.session.user && req.cookies.rememberUser) {
    const username = req.cookies.rememberUser;
    pool.query('SELECT * FROM users WHERE username = $1', [username])
      .then(result => {
        if (result.rows.length > 0) {
          req.session.user = result.rows[0];
        }
        next();
      })
      .catch(err => {
        console.error('Error in rememberUser middleware', err);
        next();
      });
  } else {
    next();
  }
});

// multer 设置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/images');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// 鉴权中间件
function isAuthenticated(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}
function isAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).send('你没有管理员权限');
}

// ========== 路由 ==========

// Admin 添加产品（带多图上传）
app.post('/admin/add', isAuthenticated, isAdmin, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'image3', maxCount: 1 },
  { name: 'image4', maxCount: 1 }
]), async (req, res) => {
  const { productName, quantity, price } = req.body;
  const image1Path = req.files['image'] ? 'images/' + req.files['image'][0].filename : null;
  const image2Path = req.files['image2'] ? 'images/' + req.files['image2'][0].filename : null;
  const image3Path = req.files['image3'] ? 'images/' + req.files['image3'][0].filename : null;
  const image4Path = req.files['image4'] ? 'images/' + req.files['image4'][0].filename : null;

  const sql = `
    INSERT INTO products (productName, quantity, price, image, image2, image3, image4)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `;
  try {
    await pool.query(sql, [
      productName, quantity, price,
      image1Path, image2Path, image3Path, image4Path
    ]);
    res.send('✅ 产品添加成功！<a href="/admin">返回</a>');
  } catch (err) {
    console.error('Error inserting product:', err);
    res.status(500).send('添加产品失败');
  }
});

// 显示某个产品页
app.get('/product/:id', async (req, res) => {
  const productId = req.params.id;
  const sql = 'SELECT * FROM products WHERE productid = $1';
  try {
    const result = await pool.query(sql, [productId]);
    if (result.rows.length > 0) {
      res.render('product', { product: result.rows[0] });
    } else {
      res.status(404).send('Product not found');
    }
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Error retrieving product');
  }
});

// 登录页面
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// 登录提交
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const sql = 'SELECT * FROM users WHERE username = $1 AND password = $2';
  try {
    const result = await pool.query(sql, [username, password]);
    const rows = result.rows;
    if (rows.length > 0) {
      const user = rows[0];
      req.session.user = user;
      req.session.username = user.username;
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.loggedIn = true;

      if (user.role === 'admin') {
        res.redirect('/admin');
      } else {
        res.redirect('/');
      }
    } else {
      res.render('login', { error: 'Username or Password Error 用户名或密码错误' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('登录出错');
  }
});

// Admin 面板主页
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  const productsSql = `
    SELECT p.productid, p.productname, p.quantity, p.price, p.image, p.status, p.collectionid
    FROM products p
    ORDER BY p.productid
  `;
  const collectionsSql = `SELECT * FROM collections ORDER BY collectionname`;
  try {
    const prodRes = await pool.query(productsSql);
    const colRes = await pool.query(collectionsSql);
    res.render('admin', {
      products: prodRes.rows,
      collections: colRes.rows,
      user: req.session.user
    });
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('无法加载管理员页面');
  }
});

// Admin “添加产品” 页面（GET）
app.get('/admin/add', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const colRes = await pool.query('SELECT * FROM collections ORDER BY collectionname');
    res.render('admin_add_product', { collections: colRes.rows, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).send('加载添加产品页面失败');
  }
});

// Admin “提交新增产品” （带系列名自动新增或查找系列 id）
app.post('/admin/add-product', isAuthenticated, isAdmin, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'image3', maxCount: 1 },
  { name: 'image4', maxCount: 1 }
]), async (req, res) => {
  const { productName, collectionName, quantity, price } = req.body;

  try {
    // 查找系列
    const findSql = 'SELECT collectionid FROM collections WHERE collectionname = $1 LIMIT 1';
    const findRes = await pool.query(findSql, [collectionName]);

    let collectionId;
    if (findRes.rows.length > 0) {
      collectionId = findRes.rows[0].collectionid;
    } else {
      // 插入新系列
      const insertColSql = 'INSERT INTO collections (collectionname) VALUES ($1) RETURNING collectionid';
      const insertColRes = await pool.query(insertColSql, [collectionName]);
      collectionId = insertColRes.rows[0].collectionid;
    }

    // 插入产品
    const insertProdSql = `
      INSERT INTO products (productname, collectionid, quantity, price, image, image2, image3, image4, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'available')
    `;
    await pool.query(insertProdSql, [
      productName,
      collectionId,
      quantity,
      price,
      req.files['image'] ? 'images/' + req.files['image'][0].filename : null,
      req.files['image2'] ? 'images/' + req.files['image2'][0].filename : null,
      req.files['image3'] ? 'images/' + req.files['image3'][0].filename : null,
      req.files['image4'] ? 'images/' + req.files['image4'][0].filename : null
    ]);

    res.redirect('/admin');
  } catch (err) {
    console.error('Error adding product:', err);
    res.status(500).send('添加产品失败');
  }
});

// 首页（显示系列 + 产品）
app.get('/', async (req, res) => {
  const sql = `
    SELECT c.collectionid, c.collectionname,
           p.productid, p.productname, p.price, p.image
    FROM collections c
    LEFT JOIN products p ON c.collectionid = p.collectionid
    ORDER BY c.collectionid, p.productid
  `;
  try {
    const result = await pool.query(sql);
    const rows = result.rows;

    const collections = {};
    rows.forEach(row => {
      if (!collections[row.collectionid]) {
        collections[row.collectionid] = {
          collectionId: row.collectionid,
          collectionName: row.collectionname,
          products: []
        };
      }
      if (row.productid) {
        collections[row.collectionid].products.push({
          productId: row.productid,
          productName: row.productname,
          price: row.price,
          image: row.image
        });
      }
    });

    res.render('index', {
      collections: Object.values(collections),
      user: req.session.user
    });
  } catch (err) {
    console.error('Home page error:', err);
    res.status(500).send('加载首页出错');
  }
});

// 登出
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// 注册页面
app.get('/register', (req, res) => {
  res.render('register');
});

// 注册提交
app.post('/register', async (req, res) => {
  const { username, password, confirmPassword, email, address, phone, paymentMethod } = req.body;

  if (password !== confirmPassword) {
    return res.send('❌ 两次输入的密码不一致，请重新填写。<a href="/register">返回注册</a>');
  }

  try {
    const checkSql = 'SELECT * FROM users WHERE username = $1';
    const checkRes = await pool.query(checkSql, [username]);
    if (checkRes.rows.length > 0) {
      return res.send('❌ 用户名已被注册，请换一个。<a href="/register">返回注册</a>');
    }

    const insertSql = `
      INSERT INTO users (username, password, email, address, phone, paymentmethod)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await pool.query(insertSql, [
      username, password, email, address, phone, paymentMethod
    ]);

    res.send('✅ 注册成功！<a href="/login">点击登录</a>');
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).send('注册失败');
  }
});

// 个人资料页
app.get('/profile', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;
  try {
    const userInfoQuery = 'SELECT * FROM users WHERE id = $1';
    const userRes = await pool.query(userInfoQuery, [userId]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).send("User not found");
    }

    const collectionsRes = await pool.query('SELECT * FROM collections ORDER BY collectionname');

    const orderQuery = `
      SELECT o.orderid, o.quantity, o.orderdate,
             p.productname, p.image, p.price
      FROM orders o
      JOIN products p ON o.productid = p.productid
      WHERE o.userid = $1
      ORDER BY o.orderdate DESC
    `;
    const orderRes = await pool.query(orderQuery, [userId]);

    res.render('profile', {
      username: user.username,
      email: user.email,
      address: user.address,
      phone: user.phone,
      paymentMethod: user.paymentmethod,
      cardNumber: user.cardnumber,
      orders: orderRes.rows,
      editField: req.query.editField || null,
      collections: collectionsRes.rows
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).send('加载资料页失败');
  }
});

// 更新资料字段
app.post('/profile/updateField', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;
  const { field, value, cardNumber } = req.body;

  const allowedFields = ['email', 'address', 'phone', 'paymentmethod'];
  if (!allowedFields.includes(field)) {
    return res.status(400).send('❌ 无效的字段');
  }

  let sql, params;

  if (field === 'paymentmethod') {
    if (value === 'VISA Card') {
      sql = 'UPDATE users SET paymentmethod = $1, cardnumber = $2 WHERE id = $3';
      params = [value, cardNumber || '', userId];
    } else {
      sql = 'UPDATE users SET paymentmethod = $1, cardnumber = NULL WHERE id = $2';
      params = [value, userId];
    }
  } else {
    sql = `UPDATE users SET ${field} = $1 WHERE id = $2`;
    params = [value, userId];
  }

  try {
    await pool.query(sql, params);
    res.redirect('/profile');
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).send('更新失败');
  }
});

// 下单（针对单个产品）
app.post('/order/:productId', isAuthenticated, async (req, res) => {
  const productId = req.params.productId;
  const quantity = parseInt(req.body.quantity || 1);

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [req.session.username]);
    if (userRes.rows.length === 0) {
      return res.status(500).send('用户不存在');
    }
    const userId = userRes.rows[0].id;

    const insertSql = 'INSERT INTO orders (userid, productid, quantity) VALUES ($1, $2, $3)';
    await pool.query(insertSql, [userId, productId, quantity]);
    res.send('✅ 下单成功！<a href="/profile">查看订单</a>');
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).send('下单失败');
  }
});

// 查看购物车页面
app.get('/cart', async (req, res) => {
  const cart = req.session.cart || [];

  try {
    const collectionsRes = await pool.query('SELECT * FROM collections ORDER BY collectionname');
    const collections = collectionsRes.rows;

    if (cart.length === 0) {
      return res.render('cart', { collections, items: [], total: 0 });
    }

    const ids = cart.map(item => item.productId);
    const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(',');
    const sql = `SELECT * FROM products WHERE productid IN (${placeholders})`;

    const prodRes = await pool.query(sql, ids);
    const results = prodRes.rows;

    const items = results.map(product => {
      const cartItem = cart.find(item => item.productId == product.productid);
      return {
        ...product,
        quantity: cartItem.quantity,
        size: cartItem.size || null,
        total: cartItem.quantity * product.price
      };
    });

    const total = items.reduce((sum, item) => sum + item.total, 0);

    res.render('cart', { collections, items, total });
  } catch (err) {
    console.error('Cart error:', err);
    res.status(500).send('加载购物车失败');
  }
});

// 添加到购物车
app.post('/cart/add', (req, res) => {
  const { productId, quantity, size } = req.body;
  const qty = parseInt(quantity) || 1;

  if (!req.session.cart) {
    req.session.cart = [];
  }

  const existingIndex = req.session.cart.findIndex(item =>
    item.productId == productId && item.size === size
  );
  if (existingIndex !== -1) {
    req.session.cart[existingIndex].quantity += qty;
  } else {
    req.session.cart.push({
      productId,
      quantity: qty,
      size: size || null
    });
  }

  res.redirect('/cart');
});

// 更新购物车（增减数量）
app.post('/cart/update', (req, res) => {
  const { productId, action } = req.body;
  const size = req.body.size || null;
  const cart = req.session.cart || [];

  const item = cart.find(i => i.productId == productId && (i.size === size));
  if (item) {
    if (action === 'increase') {
      item.quantity++;
    } else if (action === 'decrease') {
      item.quantity--;
      if (item.quantity <= 0) {
        req.session.cart = cart.filter(i => !(i.productId == productId && i.size === size));
      }
    }
    if (size) {
      item.size = size;
    }
  }
  res.redirect('/cart');
});

// 从购物车删除商品
app.post('/cart/remove', (req, res) => {
  const { productId } = req.body;
  req.session.cart = (req.session.cart || []).filter(item => item.productId != productId);
  res.redirect('/cart');
});

// 结账：把购物车的每项插入 orders，事务处理
app.post('/cart/checkout', isAuthenticated, async (req, res) => {
  const cart = req.session.cart || [];
  const userId = req.session.userId;

  if (cart.length === 0) {
    return res.send('购物车为空，无法结账。<a href="/">去购物</a>');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertOrderSql = 'INSERT INTO orders (userid, productid, quantity, orderdate) VALUES ($1, $2, $3, NOW())';

    for (let i = 0; i < cart.length; i++) {
      const item = cart[i];
      await client.query(insertOrderSql, [userId, item.productId, item.quantity]);
    }

    await client.query('COMMIT');
    req.session.cart = [];
    res.send('✅ 结账成功！订单已保存。<a href="/profile">查看订单</a>');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Checkout error:', err);
    res.status(500).send('订单保存失败，已回滚');
  } finally {
    client.release();
  }
});

// 管理员删除产品
app.post('/admin/delete/:productId', isAuthenticated, isAdmin, async (req, res) => {
  const productId = req.params.productId;
  try {
    await pool.query('DELETE FROM products WHERE productid = $1', [productId]);
    res.redirect('/admin');
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).send('删除失败');
  }
});

// 切换产品状态（available ↔ soldout）
app.post('/admin/toggle-status/:productId', isAuthenticated, isAdmin, async (req, res) => {
  const productId = req.params.productId;
  try {
    const getStatusRes = await pool.query('SELECT status FROM products WHERE productid = $1', [productId]);
    if (getStatusRes.rows.length === 0) {
      return res.status(500).send('找不到商品');
    }
    const current = getStatusRes.rows[0].status;
    const newStatus = current === 'available' ? 'soldout' : 'available';
    await pool.query('UPDATE products SET status = $1 WHERE productid = $2', [newStatus, productId]);
    res.redirect('/admin');
  } catch (err) {
    console.error('Toggle status error:', err);
    res.status(500).send('更新失败');
  }
});

// 后台查看所有订单
app.get('/admin/orders', isAuthenticated, isAdmin, async (req, res) => {
  const sql = `
    SELECT o.orderid, o.quantity, o.orderdate,
           u.username, u.address, u.phone, u.email,
           p.productname, p.price
    FROM orders o
    JOIN users u ON o.userid = u.id
    JOIN products p ON o.productid = p.productid
    ORDER BY o.orderdate DESC
  `;
  try {
    const result = await pool.query(sql);
    res.render('admin_orders', { orders: result.rows });
  } catch (err) {
    console.error('Admin orders error:', err);
    res.status(500).send('加载订单失败');
  }
});

// 后台打印单个订单
app.get('/admin/orders/:id/print', isAuthenticated, isAdmin, async (req, res) => {
  const orderId = req.params.id;
  const sql = `
    SELECT o.orderid, o.quantity, o.orderdate,
           u.username, u.address, u.phone, u.email,
           p.productname
    FROM orders o
    JOIN users u ON o.userid = u.id
    JOIN products p ON o.productid = p.productid
    WHERE o.orderid = $1
  `;
  try {
    const result = await pool.query(sql, [orderId]);
    if (result.rows.length === 0) {
      return res.status(404).send('订单不存在');
    }
    const order = result.rows[0];
    res.render('print_order', { order });
  } catch (err) {
    console.error('Print order error:', err);
    res.status(500).send('加载订单打印页失败');
  }
});

// 结账页面
app.get('/checkout', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;
  const cart = req.session.cart || [];

  if (cart.length === 0) {
    return res.send('购物车是空的，请先加东西！<a href="/">去购物</a>');
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(500).send('无法取得用户资料');
    }
    const user = userRes.rows[0];

    const ids = cart.map(item => item.productId);
    const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(',');
    const sql = `SELECT * FROM products WHERE productid IN (${placeholders})`;
    const prodRes = await pool.query(sql, ids);
    const productResults = prodRes.rows;

    const items = productResults.map(p => {
      const item = cart.find(i => i.productId == p.productid);
      return {
        productName: p.productname,
        price: p.price,
        quantity: item.quantity,
        size: item.size,
        total: item.quantity * p.price
      };
    });

    const total = items.reduce((sum, it) => sum + it.total, 0);

    res.render('checkout', {
      user,
      items,
      total,
      cartCount: cart.reduce((sum, i) => sum + i.quantity, 0)
    });
  } catch (err) {
    console.error('Checkout page error:', err);
    res.status(500).send('加载结账页失败');
  }
});

// 付款页面
app.get('/payment', isAuthenticated, async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) {
    return res.send('❌ 没有商品可付款');
  }

  try {
    const ids = cart.map(item => item.productId);
    const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(',');
    const sql = `SELECT productid, price, productname FROM products WHERE productid IN (${placeholders})`;
    const prodRes = await pool.query(sql, ids);
    const results = prodRes.rows;

    const cartWithPrice = cart.map(item => {
      const product = results.find(p => p.productid == item.productId);
      return {
        ...item,
        price: product ? product.price : 0,
        productName: product ? product.productname : '未知商品',
        subTotal: product ? product.price * item.quantity : 0
      };
    });

    const total = cartWithPrice.reduce((sum, it) => sum + it.subTotal, 0);
    const shipping = 10;
    const grandTotal = total + shipping;

    req.session.paymentStartTime = Date.now();
    req.session.cart = cartWithPrice;

    res.render('payment', {
      user: req.session.user,
      cart: cartWithPrice,
      total,
      grandTotal
    });
  } catch (err) {
    console.error('Payment page error:', err);
    res.status(500).send('加载付款页失败');
  }
});

// 添加系列
app.post('/admin/collections/add', isAuthenticated, isAdmin, async (req, res) => {
  const { name } = req.body;
  try {
    await pool.query('INSERT INTO collections (name) VALUES ($1)', [name]);
    res.redirect('/admin/collections');
  } catch (err) {
    console.error('Add collection error:', err);
    res.status(500).send('添加系列失败');
  }
});

// 再次（遗留）添加产品 route
// 此路由如果你觉得没用了可以删掉。下面只是按照你的原来代码改写
app.post('/admin/add-product', upload.single('image'), async (req, res) => {
  const { productName, price, collectionName } = req.body;
  const image = req.file ? req.file.filename : null;

  if (!productName || !price || !collectionName || !image) {
    return res.status(400).send('所有字段都必须填写');
  }

  try {
    const checkSql = 'SELECT collectionid FROM collections WHERE name = $1 LIMIT 1';
    const checkRes = await pool.query(checkSql, [collectionName]);
    let collectionId;
    if (checkRes.rows.length > 0) {
      collectionId = checkRes.rows[0].collectionid;
    } else {
      const insertColSql = 'INSERT INTO collections (name) VALUES ($1) RETURNING collectionid';
      const insertRes = await pool.query(insertColSql, [collectionName]);
      collectionId = insertRes.rows[0].collectionid;
    }

    const insertProdSql = `
      INSERT INTO products (productname, price, image, collectionid)
      VALUES ($1, $2, $3, $4)
    `;
    await pool.query(insertProdSql, [productName, price, image, collectionId]);

    res.redirect('/admin/products');
  } catch (err) {
    console.error('Add-product fallback route error:', err);
    res.status(500).send('添加产品失败');
  }
});

app.get('/admin/add-product', async (req, res) => {
  try {
    const colRes = await pool.query('SELECT * FROM collections');
    res.render('admin-add-product', { collections: colRes.rows });
  } catch (err) {
    console.error('GET add-product error:', err);
    res.status(500).send('加载页面失败');
  }
});

// 订单确认页面 / 下单确认
app.post('/order-confirm', isAuthenticated, async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) {
    return res.send('❌ 购物车为空，无法确认订单');
  }

  const paymentStart = req.session.paymentStartTime;
  const now = Date.now();
  if (!paymentStart || now - paymentStart > 10 * 60 * 1000) {
    return res.send('⛔ 付款超时，订单已失效，请重新下单。<a href="/checkout">返回购物车</a>');
  }

  const userId = req.session.userId;
  if (!userId) {
    return res.send('❌ 用户未登录或 session 失效');
  }

  try {
    const total = cart.reduce((sum, it) => sum + (it.price * it.quantity), 0);
    const shipping = 10;
    const grandTotal = total + shipping;

    const itemsJson = JSON.stringify(cart);
    const sql = `
      INSERT INTO orders (userid, items, total, status, createdat)
      VALUES ($1, $2, $3, $4, $5)
    `;
    await pool.query(sql, [userId, itemsJson, grandTotal, 'Paid', new Date()]);

    req.session.cart = [];
    res.render('order-success', { user: req.session.user, order: { userId, items: cart, total: grandTotal, status: 'Paid' }, cart });
  } catch (err) {
    console.error('Order confirm error:', err);
    res.status(500).send('下单失败，请稍后再试');
  }
});

// Feedback 页面（GET）
app.get('/feedback', (req, res) => {
  const user = (req.session.user && req.session.loggedIn) ? req.session.user : null;
  res.render('feedback', {
    successMessage: null,
    errorMessage: null,
    user,
    cartCount: req.session.cart ? req.session.cart.reduce((sum, i) => sum + i.quantity, 0) : 0
  });
});

// Feedback 提交（POST）
app.post('/feedback', async (req, res) => {
  const { name, email, subject, message } = req.body;
  const user = (req.session.user && req.session.loggedIn) ? req.session.user : null;
  const cartCount = req.session.cart ? req.session.cart.reduce((sum, i) => sum + i.quantity, 0) : 0;

  if (!email || !subject || !message) {
    return res.render('feedback', {
      successMessage: null,
      errorMessage: 'Please fill all required fields.',
      user,
      cartCount
    });
  }

  let transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  const mailOptions = {
    from: `"${name}" <${process.env.GMAIL_USER}>`,
    replyTo: email,
    to: process.env.GMAIL_USER,
    subject: `[Feedback] ${subject}`,
    text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.render('feedback', {
      successMessage: 'Thank you for your feedback! We will get back to you soon.',
      errorMessage: null,
      user,
      cartCount
    });
  } catch (err) {
    console.error('Feedback send error:', err);
    res.render('feedback', {
      successMessage: null,
      errorMessage: 'Oops! Something went wrong. Please try again later.',
      user,
      cartCount
    });
  }
});

// 启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
