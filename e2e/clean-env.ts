import process from "node:process";

for (const name of Object.keys(process.env)) {
  if (name.startsWith("FLEET_") || name === "BOARD_URL") Reflect.deleteProperty(process.env, name);
}
