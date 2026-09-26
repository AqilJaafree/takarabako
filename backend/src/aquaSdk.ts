import { createRequire } from "node:module";
import type * as SwapVmSdk from "@1inch/swap-vm-sdk";
import type * as AquaSdk from "@1inch/aqua-sdk";

/// The 1inch SDKs, loaded through their CommonJS builds: their ESM builds
/// import files without extensions (e.g. "@1inch/byte-utils/dist/constants"),
/// which Node's ESM loader rejects. Types still come from the packages.
const require = createRequire(import.meta.url);
export const sv = require("@1inch/swap-vm-sdk") as typeof SwapVmSdk;
export const aq = require("@1inch/aqua-sdk") as typeof AquaSdk;
