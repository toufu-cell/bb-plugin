// The Archive section is frontend-only. BB requires a server entry, so this
// factory only reports that the plugin loaded.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
    bb.log.info("loaded");
}
