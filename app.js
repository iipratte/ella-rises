require('dotenv').config();
const express = require("express");
const session = require("express-session");
let path = require("path");
let app = express();

const port = process.env.PORT || 3000;

app.set("view engine", "ejs");

app.use(express.static('public'));

app.use(
    session(
        {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
        }
    )
);

const knex = require("knex")({
    client: "pg",
    connection: {
        host : process.env.DB_HOST,
        user : process.env.DB_USER,
        password : process.env.DB_PASSWORD,
        database : process.env.DB_NAME,
        port : process.env.DB_PORT,
    }
});

// Tells Express how to read form data sent in the body of a request
app.use(express.urlencoded({extended: true}));

app.get("/", (req, res) => {
    res.render("index");
});

app.get("/login", (req, res) => {
    res.render("login");
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
  
    try {
      if (!username || !password) {
        return res.render('login', {
          error: 'Username and password are required.',
          username
        });
      }
  
      const user = await knex('users')
        .where({ username })
        .first(); // SELECT * FROM users WHERE username = ? LIMIT 1[web:112][web:128]
  
      if (!user || user.password !== password) {
        return res.render('login', {
          error: 'Invalid username or password.',
          username
        });
      }
  
      // Store minimal info in session
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.level = user.level;
  
      // Example: send admins to /admin, others to /
      if (user.level === 'M') {
        return res.redirect('/admin');
      } else {
        return res.redirect('/');
      }
    } catch (err) {
        console.error('Login error:', err);
        console.error('Error details:', err.message);
        console.error('Error stack:', err.stack);
        return res.render('login', {
          error: 'An error occurred while logging in. Please try again.',
          username
        });
      }
  });
  

app.get("/signup", (req, res) => {
    res.render("signup");
});

app.get("admin", (req, res) => {
    res.render("admin");
});

app.get("/participants", (req, res) => {
    res.render("participants");
});

app.get("/events", (req, res) => {
    res.render("events");
});

app.get("/survey", (req, res) => {

    const role = req.user?.role;

    res.render("survey", {role});
});


app.get("/milestones", (req, res) => {
    res.render("milestones");
});

app.get("/donations", (req, res) => {
    res.render("donations");
});

app.listen(port, () => console.log(`Server running on port ${port}`));