import { CHANNEL_CONFIG_METADATA, CHANNEL_REQUIRED_FIELDS, CHANNEL_SECRET_FIELD_KEYS, CHANNEL_SECRET_FIELDS, CHANNEL_SECRET_FIELD_MAP } from "./channel-meta.js";

describe("shared channel metadata", () => {
  it("uses one required-field map for every declared channel", () => {
    expect(Object.keys(CHANNEL_REQUIRED_FIELDS).sort()).toEqual(Object.keys(CHANNEL_CONFIG_METADATA).sort());
    for (const [name, meta] of Object.entries(CHANNEL_CONFIG_METADATA)) {
      expect(CHANNEL_REQUIRED_FIELDS[name]).toEqual(meta.requiredFields);
      expect(CHANNEL_SECRET_FIELDS[name]).toEqual(meta.secretFields);
    }
  });

  it("maps every secret field declared by a channel to a masked input", () => {
    const fields = new Set(Object.values(CHANNEL_SECRET_FIELDS).flat());
    for (const field of fields) expect(CHANNEL_SECRET_FIELD_MAP[field]).toBeDefined();
    expect([...CHANNEL_SECRET_FIELD_KEYS].sort()).toEqual(Object.keys(CHANNEL_SECRET_FIELD_MAP).sort());
  });
});
