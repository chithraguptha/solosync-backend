import "dotenv/config";
import { startApp } from "./app";

startApp().catch((error) => {
  console.error(error);
});
