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

app.listen(port, () => console.log(`Server running on port ${port}`));