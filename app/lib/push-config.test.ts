import { createECDH } from "node:crypto";
import { getPushConfig, type PushEnvironment } from "./push-config";

function generateTestVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

const keyPair = generateTestVapidKeys();
const validEnvironment: PushEnvironment = {
  VAPID_PUBLIC_KEY: keyPair.publicKey,
  VAPID_PRIVATE_KEY: keyPair.privateKey,
  VAPID_SUBJECT: "mailto:push@example.com",
};

describe("getPushConfig", () => {
  it("disables push when configuration is absent or partial", () => {
    expect(getPushConfig({})).toBeNull();
    expect(getPushConfig({ ...validEnvironment, VAPID_PRIVATE_KEY: undefined })).toBeNull();
  });

  it("accepts valid VAPID key material and mailto/HTTPS subjects", () => {
    expect(getPushConfig(validEnvironment)).toEqual({
      publicKey: validEnvironment.VAPID_PUBLIC_KEY,
      privateKey: validEnvironment.VAPID_PRIVATE_KEY,
      subject: validEnvironment.VAPID_SUBJECT,
    });
    expect(
      getPushConfig({ ...validEnvironment, VAPID_SUBJECT: "https://streampay.example/contact" }),
    ).not.toBeNull();
  });

  it("disables push for malformed VAPID key material", () => {
    expect(getPushConfig({ ...validEnvironment, VAPID_PUBLIC_KEY: "A".repeat(87) })).toBeNull();
    expect(getPushConfig({ ...validEnvironment, VAPID_PRIVATE_KEY: "B".repeat(43) })).toBeNull();
    expect(
      getPushConfig({
        ...validEnvironment,
        VAPID_PUBLIC_KEY: generateTestVapidKeys().publicKey,
      }),
    ).toBeNull();
  });

  it.each(["http://streampay.example", "not-a-subject", "https://user:pass@example.com"])(
    "disables push for invalid VAPID subject %s",
    (subject) => {
      expect(getPushConfig({ ...validEnvironment, VAPID_SUBJECT: subject })).toBeNull();
    },
  );
});
