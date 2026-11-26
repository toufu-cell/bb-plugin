// Bottom Terminal runs entirely in the app bundle. BB 0.50.1 still requires a
// server entry in the manifest, so this factory registers nothing.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(_bb: BbPluginApi): void {}
