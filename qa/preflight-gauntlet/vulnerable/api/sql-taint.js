const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/users/direct", (req, res) => {
  const userId = req.query.id;
  const query = "SELECT * FROM users WHERE id = " + userId;

  db.query(query, (error, rows) => {
    if (error) {
      return res.status(500).send("Query failed");
    }

    return res.json(rows);
  });
});

router.get("/users/template", (req, res) => {
  const email = req.query.email;
  const query = `SELECT id, email FROM users WHERE email = '${email}'`;

  db.query(query, (error, rows) => {
    if (error) {
      return res.status(500).send("Query failed");
    }

    return res.json(rows);
  });
});

router.get("/users/indirect", (req, res) => {
  const tenantId = req.query.tenant;
  const filter = "tenant_id = " + tenantId;
  const finalQuery = "SELECT id, name FROM organizations WHERE " + filter;

  db.execute(finalQuery, (error, rows) => {
    if (error) {
      return res.status(500).send("Query failed");
    }

    return res.json(rows);
  });
});

module.exports = router;
