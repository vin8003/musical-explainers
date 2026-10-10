// External asset registry (assets/manifest.json). Files live under public/
// and are referenced from storyboards as "file:<id>". The asset stage checks
// licence metadata and file presence before anything renders.
import manifest from "../../assets/manifest.json";

export type AssetEntry = {
  id: string;
  /** Path under public/. */
  file: string;
  kind: "image" | "svg" | "audio" | "texture";
  license: string;
  source: string;
  attribution?: string;
};

const entries = ((manifest as { assets?: AssetEntry[] }).assets ?? []) as AssetEntry[];

export const assetFile = (id: string): string | null => entries.find((a) => a.id === id)?.file ?? null;
