const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/users", (req, res) => {
  const allowedTables = new Set(["users", "admins"]);
  const requestedTable = req.query.table;
  const table = allowedTables.has(requestedTable) ? requestedTable : "users";
  const query = `SELECT id, email FROM ${table} WHERE email = ? AND status = 'active'`;

  db.execute(query, [req.query.email], (error, rows) => {
    if (error) {
      return res.status(500).send("Query failed");
    }

    return res.json(rows);
  });
});

module.exports = router;
