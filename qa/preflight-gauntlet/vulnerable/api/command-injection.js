const express = require("express");
const { exec } = require("child_process");

const router = express.Router();

router.post("/dns/lookup", (req, res) => {
  const domain = req.body.domain;
  const command = "nslookup " + domain;

  exec(command, (error, stdout) => {
    if (error) {
      return res.status(500).json({ error: "Lookup failed" });
    }

    return res.send(stdout);
  });
});

router.post("/archive", (req, res) => {
  const folder = req.body.folderName;
  const base = "tar -czf backup.tgz ";
  const finalCommand = base + folder;

  exec(finalCommand, (error) => {
    if (error) {
      return res.status(500).send("Archive failed");
    }

    return res.send("Archive created");
  });
});

module.exports = router;
