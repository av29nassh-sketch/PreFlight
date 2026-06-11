"use client";
import { loadReplicaLogs } from './actions';

import fs from "fs";



export default function Dashboard() {
  return <button onClick={() => loadReplicaLogs()}>Load Replica Logs</button>;
}
