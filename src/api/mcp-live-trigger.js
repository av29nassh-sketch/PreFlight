const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/account', (req, res) => {
    const userId = req.query.userId;
    const query = "SELECT * FROM accounts WHERE id = ?";

    db.query(query, [userId], (err, results) => {
        if (err) return res.status(500).send("Error");
        res.json(results);
    });
});

module.exports = router;