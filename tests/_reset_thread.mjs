import { DatabaseSync } from "node:sqlite";
const thread = process.argv[2];
const db = new DatabaseSync("data/runtime.db");
const result = db.prepare("UPDATE conversation_events SET distilled_at = NULL WHERE thread = ?").run(thread);
console.log(`reset ${result.changes} event(s) in ${thread}`);
