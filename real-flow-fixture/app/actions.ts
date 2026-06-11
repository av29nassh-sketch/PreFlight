"use server";

import fs from "fs";

export const loadReplicaLogs = async () => {
  return fs.readFileSync("/var/log/preflight-replica.log", "utf8");
};
