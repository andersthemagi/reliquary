// Vercel entry point: one function for the whole app. The build step (tsc)
// compiles src/ to dist/ first; vercel.json rewrites every path here, after
// static files in public/ have had their turn on the CDN.
import { handle } from "../dist/server.js";

export default handle;
