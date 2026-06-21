const express = require('express');
const router = express.Router();
const db = require('../db');
const { exec } = require('child_process');

// 1. THE FALSE POSITIVE TRAP (Scanner should ignore this)
router.get('/safe-users', (req, res) => {
    const table = "users";
    const safeQuery = `SELECT id, name FROM ${table} WHERE role = ?`;
    db.execute(safeQuery, [req.query.role], (err, results) => {
        res.json(results);
    });
});

// 2. THE SNEAKY INJECTION (Scanner should catch this)
router.post('/ping-server', (req, res) => {
    const targetIp = req.body.ip;
    
    if (!targetIp || typeof targetIp !== 'string') {
        return res.status(400).send("Invalid IP address");
    }
    
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    
    if (!ipv4Regex.test(targetIp) && !ipv6Regex.test(targetIp)) {
        return res.status(400).send("Invalid IP address format");
    }
    
    exec('ping', ['-c', '4', targetIp], (error, stdout) => {
        if (error) return res.status(500).send("Ping failed");
        res.send(stdout);
    });
});

// 3. THE BUSINESS LOGIC FLAW / BOLA (Scanner should catch this)
router.post('/update-billing', (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).send("Unauthorized");
    }
    
    const { accountId, newPlan } = req.body;
    
    db.execute("SELECT account_id FROM billing WHERE account_id = ? AND user_id = ?", [accountId, req.user.id], (err, results) => {
        if (err) {
            return res.status(500).send("Database error");
        }
        
        if (!results || results.length === 0) {
            return res.status(403).send("Forbidden: You do not have access to this account");
        }
        
        db.execute("UPDATE billing SET plan = ? WHERE account_id = ? AND user_id = ?", [newPlan, accountId, req.user.id], (updateErr) => {
            if (updateErr) {
                return res.status(500).send("Update failed");
            }
            res.send("Billing updated successfully");
        });
    });
});

// 4. THE HARDCODED SECRET (Scanner should catch this)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

module.exports = router;
