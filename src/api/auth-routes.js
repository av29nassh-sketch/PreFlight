const express = require('express');
const router = express.Router();
const db = require('../db');

// ROUTE 1: THE FALSE POSITIVE TRAP
// This uses template literals for the table name, but safely parameterizes the user input.
// A dumb regex scanner would flag this. A smart AST scanner should pass it.
router.post('/login', (req, res) => {
    const table = "users";
    const safeQuery = `SELECT * FROM ${table} WHERE email = ? AND status = 'active'`;
    
    db.execute(safeQuery, [req.body.email], (err, results) => {
        if (err) return res.status(500).send("Error");
        res.json(results);
    });
});

// ROUTE 2: THE FALSE NEGATIVE TRAP
// This is a multi-step SQL injection. The vulnerability is constructed on line 21, 
// but executed on line 22. A weak scanner will miss this because the execution line 
// looks clean: `db.execute(finalQuery)`.
router.get('/profile', (req, res) => {
    const unsafeInput = req.query.id;
    const finalQuery = "SELECT username, email FROM users WHERE id = ?";
    
    db.execute(finalQuery, [unsafeInput], (err, results) => {
        res.json(results);
    });
});

module.exports = router;
