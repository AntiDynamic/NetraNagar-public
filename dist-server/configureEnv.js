import dotenv from "dotenv";
import path from "node:path";
// The local desktop workspace stores its development secrets beside this
// checkout. Load before importing providers that read configuration at module
// initialization; deployed environments continue to use process variables.
dotenv.config({
    path: [
        path.resolve(process.cwd(), ".env"),
        path.resolve(process.cwd(), "..", ".env"),
    ]
});
