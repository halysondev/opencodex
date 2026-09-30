/** Official RTK v0.50.0 artifacts, pinned at source commit 1d87b8e719ce0a50c223cd93ca64dd16921f9aec. */
export const RTK_VERSION = "0.50.0";
export const RTK_SOURCE_COMMIT = "1d87b8e719ce0a50c223cd93ca64dd16921f9aec";
export const RTK_RELEASE_URL = "https://github.com/rtk-ai/rtk/releases/download/v0.50.0";
export interface RtkArtifact {
  readonly archive: string;
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly filename: string;
  readonly binarySha256: string;
  readonly binarySize: number;
}
export const RTK_ARTIFACTS = {
  "bun-darwin-arm64": {
    "archive": "rtk-aarch64-apple-darwin.tar.gz",
    "archiveSha256": "fe54761a9950266e3a78ddb66a8af5e067251169da306a288e0751de63d836fe",
    "archiveSize": 4122143,
    "filename": "rtk",
    "binarySha256": "09aa3e6f79f994235f9ad86bc5c290ce04a663e73c6d018e00deac96475c786e",
    "binarySize": 8458000
  },
  "bun-linux-arm64": {
    "archive": "rtk-aarch64-unknown-linux-gnu.tar.gz",
    "archiveSha256": "d1cc49dfa2cd443fc32625444b59fe616b6c80478cca210985118347174dd758",
    "archiveSize": 4462410,
    "filename": "rtk",
    "binarySha256": "a5dc2c362aa563087388732b227756d1ef008bcd01f6bd84c07aca9ebe085ad7",
    "binarySize": 9267808
  },
  "bun-darwin-x64": {
    "archive": "rtk-x86_64-apple-darwin.tar.gz",
    "archiveSha256": "ac23e20024ab3c71e7f50069f8b34190aec1b2d8f0c2cc19834039b3dac73373",
    "archiveSize": 4512079,
    "filename": "rtk",
    "binarySha256": "a4c3c6e179dcb12518358c834c7e244496161380da3a73727bd781521395f075",
    "binarySize": 9860992
  },
  "bun-windows-x64": {
    "archive": "rtk-x86_64-pc-windows-msvc.zip",
    "archiveSha256": "cb03399305135dd59ee23eb59a3260ccdeea5a8e08fbc7a271b115b85583a6c9",
    "archiveSize": 4511565,
    "filename": "rtk.exe",
    "binarySha256": "57c9b9723388e9f421bd1f82aabf1bf093ea3012b72ebbbe0ea855d739f1d622",
    "binarySize": 10158592
  },
  "bun-linux-x64": {
    "archive": "rtk-x86_64-unknown-linux-musl.tar.gz",
    "archiveSha256": "bc2b8902b0d9c796c82ef45f16ae2307e17757afeca5ee156235a3dc7bda5f89",
    "archiveSize": 4857739,
    "filename": "rtk",
    "binarySha256": "23433a2a50bdeb12199cadd4b94b639238d6c38529fcba1c30c9295db5fa9517",
    "binarySize": 11040640
  }
} as const satisfies Readonly<Record<string, RtkArtifact>>;
export type RtkTarget = keyof typeof RTK_ARTIFACTS;
export function isRtkTarget(value: string): value is RtkTarget {
  return Object.hasOwn(RTK_ARTIFACTS, value);
}
export function rtkTarget(platform: NodeJS.Platform, arch: string): RtkTarget | undefined {
  const os = platform === "win32" ? "windows" : platform;
  const target = `bun-${os}-${arch}`;
  return isRtkTarget(target) ? target : undefined;
}
