const express = require('express');
const mysql = require('mysql2');
const app = express();
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
require('dotenv').config(); // 确保在所有 require nodemailer 之前

// ===================== 数据库连接 =======================================================
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Republic_C207',
  database: 'myshopapp'
});

connection.connect((err) => {
  if (err) {
  console.error('Error connecting to MySQL:', err);
  return;
  }
  console.log('Connected to MySQL database');
});

// ===================== 中间件 =====================
// Set up view engine
app.set('view engine', 'ejs');
// enable static files
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'mysecret',
  resave: false,
  saveUninitialized: true
}));
app.use(cookieParser());

app.use((req, res, next) => {
  res.locals.username = req.session.username || null;
  res.locals.cartCount = req.session.cart
    ? req.session.cart.reduce((sum, item) => sum + item.quantity, 0)
    : 0;
  next();
});

app.use((req, res, next) => {
  if (!req.session.user && req.cookies.rememberUser) {
    const username = req.cookies.rememberUser;
    connection.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
      if (!err && results.length > 0) {
        req.session.user = results[0];
      }
      next();
    });
  } else {
    next();
  }
});

// Set up multer for multiple file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/images');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// 中间件：判断是否登录
function isAuthenticated(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).send('你没有管理员权限');
}

app.use(express.json()); // 但是 webhook 要用 raw，不可直接用 json()


app.post('/admin/add', isAuthenticated, isAdmin, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'image3', maxCount: 1 },
  { name: 'image4', maxCount: 1 }
]), (req, res) => {
  const { productName, quantity, price } = req.body;
  const image1Path = req.files['image'] ? 'images/' + req.files['image'][0].filename : '';
  const image2Path = req.files['image2'] ? 'images/' + req.files['image2'][0].filename : '';
  const image3Path = req.files['image3'] ? 'images/' + req.files['image3'][0].filename : '';

  const sql = 'INSERT INTO products (productName, quantity, price, image, image2, image3) VALUES (?, ?, ?, ?, ?, ?)';
  connection.query(sql, [productName, quantity, price, image1Path, image2Path, image3Path], (err) => {
    if (err) throw err;
    res.send('✅ 产品添加成功！<a href="/admin">返回</a>');
  });
});


app.get('/product/:id', (req, res) => {
    const productId = req.params.id;
    const sql = 'SELECT * FROM products WHERE productId = ?';
    // Fetch data from MySQL based on the product ID
    connection.query(sql, [productId], (error, results) => {
        if (error) {
            console.error('Database query error:', error.message);
            return res.status(500).send('Error Retrieving product by ID');
        }
        // Check if any product with the given ID was found
        if (results.length > 0) {
            res.render('product', { product: results[0] });
        } else {
            res.status(404).send('Product not found');
        }
    });
});

// ===================== 登录 =====================
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  connection.query(
    'SELECT * FROM users WHERE username=? AND password=?',
    [username, password],
    (err, rows) => {
      if (err) throw err;

      if (rows.length > 0) {
        const user = rows[0];
        req.session.user = user;              // 保存整个用户对象
        req.session.username = user.username; // navbar 显示用
        req.session.userId = user.id;         // checkout/profile 用
        req.session.role = user.role;         // ⚡ 角色判断
        req.session.loggedIn = true;

        // 根据角色跳转
        if (user.role === 'admin') {
          res.redirect('/admin'); // 管理员直接去后台订单页
        } else {
          res.redirect('/');             // 普通用户去首页
        }
      } else {
        res.render('login', { error: 'Username or Password Error 用户名或密码错误' });
      }
    }
  );
});

// ===================== Admin 面板 =====================
app.get('/admin', isAuthenticated, isAdmin, (req, res) => {
  const productsSql = `
    SELECT p.productId, p.productName, p.quantity, p.price, p.image, p.status, p.collectionId
    FROM products p
    ORDER BY p.productId
  `;

  const collectionsSql = `SELECT * FROM collections ORDER BY collectionName`;

  connection.query(productsSql, (err, products) => {
    if (err) throw err;

    connection.query(collectionsSql, (err2, collections) => {
      if (err2) throw err2;

      res.render('admin', {
        products,
        collections,       // ✅ 把 collections 传给模板
        user: req.session.user
      });
    });
  });
});

// ===================== Add Product 页面 =====================
app.get('/admin/add', isAuthenticated, isAdmin, (req, res) => {
  connection.query('SELECT * FROM collections ORDER BY collectionName', (err, collections) => {
    if (err) throw err;
    res.render('admin_add_product', { collections, user: req.session.user });
  });
});

// ===================== 添加产品 (唯一入口) =====================
app.post('/admin/add-product', isAuthenticated, isAdmin, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'image3', maxCount: 1 },
  { name: 'image4', maxCount: 1 }
]), (req, res) => {
  const { productName, collectionName, quantity, price } = req.body;

  const findCollectionSQL = 'SELECT collectionId FROM collections WHERE collectionName = ? LIMIT 1';
  connection.query(findCollectionSQL, [collectionName], (err, rows) => {
    if (err) throw err;

    if (rows.length > 0) {
      insertProduct(rows[0].collectionId);
    } else {
      const insertCollectionSQL = 'INSERT INTO collections (collectionName) VALUES (?)';
      connection.query(insertCollectionSQL, [collectionName], (err2, result) => {
        if (err2) throw err2;
        insertProduct(result.insertId);
      });
    }
  });

  function insertProduct(collectionId) {
    const sql = `
      INSERT INTO products (productName, collectionId, quantity, price, image, image2, image3, image4, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available')
    `;
    connection.query(sql, [
      productName,
      collectionId,
      quantity,
      price,
      req.files['image'] ? 'images/' + req.files['image'][0].filename : null,
      req.files['image2'] ? 'images/' + req.files['image2'][0].filename : null,
      req.files['image3'] ? 'images/' + req.files['image3'][0].filename : null,
      req.files['image4'] ? 'images/' + req.files['image4'][0].filename : null,
    ], (err3) => {
      if (err3) throw err3;
      res.redirect('/admin');
    });
  }
});

// 首页：显示系列 + 产品
app.get('/', (req, res) => {
  const sql = `
    SELECT c.collectionId, c.collectionName, 
           p.productId, p.productName, p.price, p.image
    FROM collections c
    LEFT JOIN products p ON c.collectionId = p.collectionId
    ORDER BY c.collectionId, p.productId
  `;
  connection.query(sql, (err, results) => {
    if (err) throw err;

    // 按系列分组
    const collections = {};
    results.forEach(row => {
      if (!collections[row.collectionId]) {
        collections[row.collectionId] = {
          collectionId: row.collectionId,
          collectionName: row.collectionName,
          products: []
        };
      }
      if (row.productId) {
        collections[row.collectionId].products.push({
          productId: row.productId,
          productName: row.productName,
          price: row.price,
          image: row.image
        });
      }
    });

    res.render('index', { collections: Object.values(collections), user: req.session.user });
  });
});

// ===================== 登出 =====================
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// 注册页面显示
app.get('/register', (req, res) => {
  res.render('register');
});
// 处理注册逻辑/注册表单提交
app.post('/register', (req, res) => {
  const { username, password, confirmPassword, email, address, phone, paymentMethod } = req.body;

  // 检查两次密码是否一致
  if (password !== confirmPassword) {
    return res.send('❌ 两次输入的密码不一致，请重新填写。<a href="/register">返回注册</a>');
  }

  const checkSql = 'SELECT * FROM users WHERE username = ?';
  connection.query(checkSql, [username], (err, results) => {
    if (err) return res.status(500).send('数据库错误');

    if (results.length > 0) {
      return res.send('❌ 用户名已被注册，请换一个。<a href="/register">返回注册</a>');
    }

    const insertSql = 'INSERT INTO users (username, password, email, address, phone, paymentMethod) VALUES (?, ?, ?, ?, ?, ?)';
    connection.query(insertSql, [username, password, 'user', email, address, phone, paymentMethod], (err2) => {
      if (err2) return res.status(500).send('注册失败');

      res.send('✅ 注册成功！<a href="/login">点击登录</a>');
    });
  });
});

// Profile page
app.get('/profile', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const userId = req.session.userId;

  // 查询用户信息
  const userInfoQuery = `SELECT * FROM users WHERE id = ?`;
  connection.query(userInfoQuery, [userId], (err, userResults) => {
    if (err) {
      console.error('Error getting user info:', err);
      return res.status(500).send("Database error (user info)");
    }

    const editField = req.query.editField || null; // 是否编辑模式
    const user = userResults[0];
    if (!user) return res.status(404).send("User not found");

    // 查询 collections
    connection.query('SELECT * FROM collections ORDER BY collectionName', (err2, collections) => {
      if (err2) {
        console.error('Error getting collections:', err2);
        return res.status(500).send("Database error (collections)");
      }

      // 查询用户订单
      const orderQuery = `
        SELECT o.orderId, o.quantity, o.orderDate,
               p.productName, p.image, p.price
        FROM orders o
        JOIN products p ON o.productId = p.productId
        WHERE o.userId = ?
        ORDER BY o.orderDate DESC
      `;

      connection.query(orderQuery, [userId], (err3, orderResults) => {
        if (err3) {
          console.error('Error getting orders:', err3);
          return res.status(500).send("Database error (orders)");
        }

        // 渲染模板
        res.render('profile', {
          username: user.username,
          email: user.email || '',
          address: user.address || '',
          phone: user.phone || '',
          paymentMethod: user.paymentMethod || '',
          cardNumber: user.cardNumber || '',
          orders: orderResults,
          editField,
          collections // ✅ 一定要传给模板
        });
      });
    });
  });
});


app.post('/profile/updateField', isAuthenticated, (req, res) => {
  const userId = req.session.userId;
  const { field, value, cardNumber } = req.body;

  const allowedFields = ['email', 'address', 'phone', 'paymentMethod'];
  if (!allowedFields.includes(field)) {
    return res.status(400).send('❌ 无效的字段');
  }
  // 如果是更新 paymentMethod，需要处理 VISA 卡号
    if (field === 'paymentMethod' && value === 'VISA Card') {
      sql = 'UPDATE users SET paymentMethod = ?, cardNumber = ? WHERE id = ?';
      params = [value, cardNumber || '', userId];
    } else if (field === 'paymentMethod') {
      sql = 'UPDATE users SET paymentMethod = ?, cardNumber = NULL WHERE id = ?';
      params = [value, userId];
    } else {
      sql = `UPDATE users SET ${field} = ? WHERE id = ?`;
      params = [value, userId];
    }

    connection.query(sql, params, (err) => {
      if (err) {
        console.error('更新失败:', err);
        return res.status(500).send('❌ 更新失败');
      }
      res.redirect('/profile');
    });
  });


// 下单功能
app.post('/order/:productId', isAuthenticated, (req, res) => {
  const productId = req.params.productId;
  const quantity = parseInt(req.body.quantity || 1);

  const getUserIdSql = 'SELECT * FROM users WHERE username = ?';
  connection.query(getUserIdSql, [req.session.username], (err, userResults) => {
    if (err || userResults.length === 0) return res.status(500).send('用户不存在');

    const userId = userResults[0].id;
    const insertSql = 'INSERT INTO orders (userId, productId, quantity) VALUES (?, ?, ?)';
    connection.query(insertSql, [userId, productId, quantity], (err2) => {
      if (err2) return res.status(500).send('下单失败');
      res.send('✅ 下单成功！<a href="/profile">查看订单</a>');
    });
  });
});

// 查看购物车页面
app.get('/cart', (req, res) => {
  const cart = req.session.cart || [];

  // 先查 collections 用于导航栏
  connection.query('SELECT * FROM collections ORDER BY collectionName', (err, collections) => {
    if (err) throw err;

    if (cart.length === 0) {
      return res.render('cart', { collections, items: [], total: 0 });
    }

    // 有商品时再查 products
    const ids = cart.map(item => item.productId);
    const sql = `SELECT * FROM products WHERE productId IN (${ids.map(() => '?').join(',')})`;

    connection.query(sql, ids, (err2, results) => {
      if (err2) throw err2;

      const items = results.map(product => {
        const cartItem = cart.find(item => item.productId == product.productId);
        return {
          ...product,
          quantity: cartItem.quantity,
          size: cartItem.size || null,
          total: cartItem.quantity * product.price
        };
      });

      const total = items.reduce((sum, item) => sum + item.total, 0);

      res.render('cart', { collections, items, total });
    });
  });
});

// 添加到购物车
app.post('/cart/add', (req, res) => {
  const { productId, quantity, size } = req.body;
  const qty = parseInt(quantity) || 1;

  // 确保购物车存在，初始化为空数组
  if (!req.session.cart) {
    req.session.cart = [];
  }

  // 查找购物车中是否已有相同产品和尺码
  const existingIndex = req.session.cart.findIndex(item => 
    item.productId == productId && item.size === size
  );

  if (existingIndex !== -1) {
    // 已存在则累加数量
    req.session.cart[existingIndex].quantity += qty;
  } else {
    // 新商品加入购物车
    req.session.cart.push({
      productId,
      quantity: qty,
      size: size || null
    });
  }

  // 添加成功，重定向到购物车页面或者你想跳转的页面
  res.redirect('/cart');
});


// 加 / 减数量
app.post('/cart/update', (req, res) => {
  const { productId, action } = req.body;
  const size = req.body.size || null;
  const cart = req.session.cart;

  const item = cart.find(i => i.productId == productId);
  if (item) {
    if (action === 'increase') {
      item.quantity++;
    } else if (action === 'decrease') {
      item.quantity--;
      if (item.quantity <= 0) {
        req.session.cart = cart.filter(i => i.productId != productId);
      }
    }
    // 更新尺寸
    if (size) {
      item.size = size;
    }
  }
  res.redirect('/cart');
});
// 删除购物车商品
app.post('/cart/remove', (req, res) => {
  const { productId } = req.body;
  req.session.cart = req.session.cart.filter(item => item.productId != productId);
  res.redirect('/cart');
});
// 结账（清空购物车）
app.post('/cart/checkout', isAuthenticated, (req, res) => {
  const cart = req.session.cart;
  const userId = req.session.userId;

  if (!cart || cart.length === 0) {
    return res.send('购物车为空，无法结账。<a href="/">去购物</a>');
  }

  connection.beginTransaction(err => {
    if (err) return res.status(500).send('事务开启失败');

    const insertOrderSql = 'INSERT INTO orders (userId, productId, quantity, orderDate) VALUES (?, ?, ?, NOW())';
    let errorOccured = false;

    cart.forEach((item, index) => {
      connection.query(insertOrderSql, [userId, item.productId, item.quantity], (err2) => {
        if (err2) {
          errorOccured = true;
          return connection.rollback(() => {
            res.status(500).send('订单保存失败，已回滚');
          });
        }

        if (index === cart.length - 1 && !errorOccured) {
          connection.commit(err3 => {
            if (err3) {
              return connection.rollback(() => {
                res.status(500).send('事务提交失败，已回滚');
              });
            }

            req.session.cart = []; // 清空购物车
            res.send('✅ 结账成功！订单已保存。<a href="/profile">查看订单</a>');
          });
        }
      });
    });
  });
});


// 管理员删除产品
app.post('/admin/delete/:productId', isAuthenticated, isAdmin, (req, res) => {
  const productId = req.params.productId;

  const deleteSql = 'DELETE FROM products WHERE productId = ?';
  connection.query(deleteSql, [productId], (err) => {
    if (err) return res.status(500).send('❌ 删除失败');
    res.redirect('/admin');
  });
});
// 管理员更新产品Sold Out状态
app.post('/admin/toggle-status/:productId', isAuthenticated, isAdmin, (req, res) => {
  const productId = req.params.productId;

  const getStatusSql = 'SELECT status FROM products WHERE productId = ?';
  connection.query(getStatusSql, [productId], (err, results) => {
    if (err || results.length === 0) return res.status(500).send('找不到商品');

    const newStatus = results[0].status === 'available' ? 'soldout' : 'available';
    const updateSql = 'UPDATE products SET status = ? WHERE productId = ?';
    connection.query(updateSql, [newStatus, productId], (err2) => {
      if (err2) return res.status(500).send('更新失败');
      res.redirect('/admin');
    });
  });
});

// Admin edit order status
// 查看所有订单（后台用）
app.get('/admin/orders', isAuthenticated, isAdmin, (req, res) => {
  const sql = `
    SELECT 
      o.orderId, o.quantity, o.orderDate,
      u.username, u.address, u.phone, u.email,
      p.productName, p.price
    FROM orders o
    JOIN users u ON o.userId = u.id
    JOIN products p ON o.productId = p.productId
    ORDER BY o.orderDate DESC
  `;

  connection.query(sql, (err, results) => {
    if (err) {
      console.error('Error retrieving orders:', err);
      return res.status(500).send('数据库错误');
    }
    res.render('admin_orders', { orders: results });
  });
});

// 管理员打印订单
app.get('/admin/orders/:id/print', isAuthenticated, isAdmin, (req, res) => {
  const orderId = req.params.id;

  const sql = `
    SELECT 
      o.orderId, o.quantity, o.orderDate,
      u.username, u.address, u.phone, u.email,
      p.productName
    FROM orders o
    JOIN users u ON o.userId = u.id
    JOIN products p ON o.productId = p.productId
    WHERE o.orderId = ?
  `;

  connection.query(sql, [orderId], (err, results) => {
    if (err || results.length === 0) {
      return res.status(404).send('订单不存在');
    }

    const order = results[0];
    res.render('print_order', { order });
  });
});

// Checkout page
app.get('/checkout', isAuthenticated, (req, res) => {
  const userId = req.session.userId;
  const cart = req.session.cart || [];

  if (cart.length === 0) {
    return res.send('购物车是空的，请先加东西！<a href="/">去购物</a>');
  }

  const userSql = 'SELECT * FROM users WHERE id = ?';
  connection.query(userSql, [userId], (err, userResults) => {
    if (err || userResults.length === 0) {
      return res.status(500).send('无法取得用户资料');
    }

    const user = userResults[0];

    // 查询购物车里的产品
    const ids = cart.map(item => item.productId);
    const sql = `SELECT * FROM products WHERE productId IN (${ids.map(() => '?').join(',')})`;

    connection.query(sql, ids, (err2, productResults) => {
      if (err2) throw err2;

      const items = productResults.map(p => {
        const item = cart.find(i => i.productId == p.productId);
        return {
          productName: p.productName,
          price: p.price,
          quantity: item.quantity,
          size: item.size,
          total: item.quantity * p.price
        };
      });

      const total = items.reduce((sum, item) => sum + item.total, 0);

      res.render("checkout", {
        user: user,          // ✅ 顾客信息
        items: items,        // ✅ 订单内容
        total: total,        // ✅ 总价
        cartCount: cart.reduce((sum, i) => sum + i.quantity, 0) // ✅ 导航栏显示购物车数量
      });
    });
  });
});

//========Payment page=====================================
// Payment page
app.get('/payment', isAuthenticated, (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.send('❌ 没有商品可付款');

  const ids = cart.map(item => item.productId);
  const sql = `SELECT productId, price, productName FROM products WHERE productId IN (${ids.map(() => '?').join(',')})`;

  connection.query(sql, ids, (err, results) => {
    if (err) return res.status(500).send('数据库错误');

    const cartWithPrice = cart.map(item => {
      const product = results.find(p => p.productId == item.productId);
      return {
        ...item,
        price: product ? product.price : 0,
        productName: product ? product.productName : '未知商品',
        subTotal: product ? product.price * item.quantity : 0
      };
    });

    const total = cartWithPrice.reduce((sum, item) => sum + item.subTotal, 0);
    const shipping = 10;
    const grandTotal = total + shipping;

    // ⚡ 存付款开始时间
    req.session.paymentStartTime = Date.now();

    // ⚡ 保证 session 里的 cart 有最新 price
    req.session.cart = cartWithPrice;

    res.render('payment', {
      user: req.session.user,
      cart: cartWithPrice,
      total,
      grandTotal
    });
  });
});

// 添加系列
app.post('/admin/collections/add', isAuthenticated, isAdmin, (req, res) => {
  const { name } = req.body;
  connection.query('INSERT INTO collections (name) VALUES (?)', [name], (err) => {
    if (err) throw err;
    res.redirect('/admin/collections');
  });
});

app.post('/admin/add-product', upload.single('image'), (req, res) => {
  const { productName, price, collectionName } = req.body;
  const image = req.file ? req.file.filename : null;

  if (!productName || !price || !collectionName || !image) {
    return res.status(400).send('所有字段都必须填写');
  }

  // 先检查 collectionName 是否已存在
  const checkSql = 'SELECT collectionId FROM collections WHERE name = ? LIMIT 1';
  connection.query(checkSql, [collectionName], (err, results) => {
    if (err) throw err;

    if (results.length > 0) {
      // 系列已存在
      const collectionId = results[0].collectionId;
      insertProduct(collectionId);
    } else {
      // 系列不存在，先插入新系列
      const insertCollectionSql = 'INSERT INTO collections (name) VALUES (?)';
      connection.query(insertCollectionSql, [collectionName], (err, result) => {
        if (err) throw err;
        const newCollectionId = result.insertId;
        insertProduct(newCollectionId);
      });
    }
  });

  // 插入商品函数
  function insertProduct(collectionId) {
    const insertProductSql = `
      INSERT INTO products (productName, price, image, collectionId)
      VALUES (?, ?, ?, ?)
    `;
    connection.query(insertProductSql, [productName, price, image, collectionId], (err) => {
      if (err) throw err;
      res.redirect('/admin/products'); // 添加成功跳回商品列表
    });
  }
});

app.get('/admin/add-product', (req, res) => {
  connection.query('SELECT * FROM collections', (err, collections) => {
    if (err) throw err;
    res.render('admin-add-product', { collections });
  });
});

// ===================== 订单成功页面 =====================
app.post('/order-confirm', isAuthenticated, (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.send('❌ 购物车为空，无法确认订单');

  const paymentStart = req.session.paymentStartTime;
  const now = Date.now();

  if (!paymentStart || now - paymentStart > 10 * 60 * 1000) {
    return res.send('⛔ 付款超时，订单已失效，请重新下单。<a href="/checkout">返回购物车</a>');
  }

  const userId = req.session.userId;
  if (!userId) return res.send('❌ 用户未登录或 session 失效');

  const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const shipping = 10;
  const grandTotal = total + shipping;

  const order = {
    userId: userId,
    items: JSON.stringify(cart),
    total: grandTotal,
    shipping,
    status: 'Paid',
    createdAt: new Date()
  };

  const sql = 'INSERT INTO orders (userId, items, total, status, createdAt) VALUES (?, ?, ?, ?, ?)';
  connection.query(sql, [order.userId, order.items, order.total, order.status, order.createdAt], (err) => {
    if (err) {
      console.error('下单失败原因:', err); // 🔥 打印详细错误
      return res.send('❌ 下单失败，请稍后再试');
    }

    req.session.cart = []; // 清空购物车
    res.render('order-success', { user: req.session.user, order, cart });
  });
});

//=============Feedback 表单===========================================
app.get('/feedback', (req, res) => {
  const user = (req.session.user && req.session.loggedIn) ? req.session.user : null;
  res.render('feedback', { 
    successMessage: null, 
    errorMessage: null, 
    user,
    cartCount: req.session.cart ? req.session.cart.reduce((sum, item) => sum + item.quantity, 0) : 0
  });
});

// POST 提交 feedback
app.post('/feedback', async (req, res) => {
  const { name, email, subject, message } = req.body;

  // 统一获取 user 和 cartCount
  const user = (req.session.user && req.session.loggedIn) ? req.session.user : null;
  const cartCount = req.session.cart ? req.session.cart.reduce((sum, item) => sum + item.quantity, 0) : 0;

  // 检查必填字段
  if (!email || !subject || !message) {
    return res.render('feedback', { 
      successMessage: null,
      errorMessage: 'Please fill all required fields.',
      user,
      cartCount
    });
  }

  // 创建 transporter
  let transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  // 邮件内容
  let mailOptions = {
    from: `"${name}" <${process.env.GMAIL_USER}>`, // 发件人为店家，但显示顾客名字
    replyTo: email,                                // 回复时直接回复顾客邮箱
    to: process.env.GMAIL_USER,                    // 店家收件
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
    console.error(err);
    res.render('feedback', { 
      successMessage: null, 
      errorMessage: 'Oops! Something went wrong. Please try again later.',
      user,
      cartCount
    });
  }
});


// ===================== 启动端口 =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));