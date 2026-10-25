import { describe, expect, it } from "vitest";

import { toBase64Url, utf8Encode, webCryptoRandomBytes } from "./bytes.js";
import {
  acceptClientHello,
  ChannelError,
  generateKeyPair,
  HandshakeError,
  hashSecret,
  keyPairFromSecret,
  type SecureChannel,
  startClientHandshake,
} from "./crypto.js";
import { ClientHello, ServerWelcome } from "./messages.js";

const random = webCryptoRandomBytes;
const pairingId = toBase64Url(random(16));
const deviceId = toBase64Url(random(16));

function setup() {
  return { desktop: generateKeyPair(random), phone: generateKeyPair(random), secret: random(32) };
}

function pairedChannels(): { phone: SecureChannel; desktop: SecureChannel } {
  const { desktop, phone, secret } = setup();
  const client = startClientHandshake({
    serverPublicKey: desktop.publicKey,
    clientStatic: phone,
    target: { mode: "pair", pairingId, pairingSecret: secret },
    random,
  });
  const accepted = acceptClientHello({ hello: client.hello, serverStatic: desktop, psk: secret, random });
  return { phone: client.finish(accepted.welcome), desktop: accepted.channel };
}

function flipFirstBit(text: string): string {
  const first = text.charAt(0) === "A" ? "B" : "A";
  return first + text.slice(1);
}

describe("handshake", () => {
  it("pairs with the one-time secret and opens a working channel both ways", () => {
    const { desktop, phone, secret } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId, pairingSecret: secret },
      random,
    });
    expect(ClientHello.parse(client.hello)).toEqual(client.hello);
    const accepted = acceptClientHello({ hello: client.hello, serverStatic: desktop, psk: secret, random });
    expect(ServerWelcome.parse(accepted.welcome)).toEqual(accepted.welcome);
    expect(accepted.clientStatic).toEqual(phone.publicKey);
    const phoneChannel = client.finish(accepted.welcome);

    expect(accepted.channel.openJson(phoneChannel.sealJson({ type: "ping", n: 1 }))).toEqual({ type: "ping", n: 1 });
    expect(phoneChannel.openJson(accepted.channel.sealJson({ type: "pong", text: "héllo 🚀" }))).toEqual({
      type: "pong",
      text: "héllo 🚀",
    });
  });

  it("resumes a paired phone without a secret", () => {
    const { desktop, phone } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "resume", deviceId },
      random,
    });
    expect(client.hello.mode).toBe("resume");
    const accepted = acceptClientHello({ hello: client.hello, serverStatic: desktop, random });
    const channel = client.finish(accepted.welcome);
    expect(accepted.channel.openJson(channel.sealJson("hi"))).toBe("hi");
  });

  it("rejects a hello made with the wrong pairing secret", () => {
    const { desktop, phone, secret } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId, pairingSecret: random(32) },
      random,
    });
    expect(() => acceptClientHello({ hello: client.hello, serverStatic: desktop, psk: secret, random })).toThrow(
      HandshakeError,
    );
  });

  it("rejects a pair hello when the desktop has no secret for it", () => {
    const { desktop, phone, secret } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId, pairingSecret: secret },
      random,
    });
    expect(() => acceptClientHello({ hello: client.hello, serverStatic: desktop, random })).toThrow(HandshakeError);
  });

  it("rejects a hello aimed at a different desktop key", () => {
    const { desktop, phone, secret } = setup();
    const impostor = generateKeyPair(random);
    const client = startClientHandshake({
      serverPublicKey: impostor.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId, pairingSecret: secret },
      random,
    });
    expect(() => acceptClientHello({ hello: client.hello, serverStatic: desktop, psk: secret, random })).toThrow(
      HandshakeError,
    );
  });

  it("rejects a hello whose keys or ids were swapped in transit", () => {
    const { desktop, phone, secret } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId, pairingSecret: secret },
      random,
    });
    const other = generateKeyPair(random);
    const tampered: ClientHello[] = [
      { ...client.hello, clientStatic: toBase64Url(other.publicKey) },
      { ...client.hello, clientEphemeral: toBase64Url(other.publicKey) },
      { ...client.hello, proof: flipFirstBit(client.hello.proof) },
      { ...client.hello, mode: "pair", pairingId: toBase64Url(random(16)) },
    ];
    for (const hello of tampered) {
      expect(() => acceptClientHello({ hello, serverStatic: desktop, psk: secret, random })).toThrow(HandshakeError);
    }
  });

  it("does not let a resume hello stand in for a pair hello", () => {
    const { desktop, phone, secret } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "resume", deviceId: pairingId },
      random,
    });
    if (client.hello.mode !== "resume") throw new Error("expected a resume hello");
    const { deviceId: id, ...rest } = client.hello;
    const relabelled: ClientHello = { ...rest, mode: "pair", pairingId: id };
    expect(() => acceptClientHello({ hello: relabelled, serverStatic: desktop, psk: secret, random })).toThrow(
      HandshakeError,
    );
  });

  it("makes the phone reject a welcome from anyone without the desktop's secret key", () => {
    const { desktop, phone, secret } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId, pairingSecret: secret },
      random,
    });
    const accepted = acceptClientHello({ hello: client.hello, serverStatic: desktop, psk: secret, random });
    const forged = { ...accepted.welcome, serverEphemeral: toBase64Url(generateKeyPair(random).publicKey) };
    expect(() => client.finish(forged)).toThrow(HandshakeError);
    expect(() => client.finish({ ...accepted.welcome, proof: flipFirstBit(accepted.welcome.proof) })).toThrow(
      HandshakeError,
    );
  });

  it("rejects low-order public keys", () => {
    const { desktop, phone, secret } = setup();
    const client = startClientHandshake({
      serverPublicKey: desktop.publicKey,
      clientStatic: phone,
      target: { mode: "pair", pairingId, pairingSecret: secret },
      random,
    });
    const zero = toBase64Url(new Uint8Array(32));
    expect(() =>
      acceptClientHello({
        hello: { ...client.hello, clientEphemeral: zero },
        serverStatic: desktop,
        psk: secret,
        random,
      }),
    ).toThrow(HandshakeError);
    expect(() =>
      startClientHandshake({
        serverPublicKey: new Uint8Array(32),
        clientStatic: phone,
        target: { mode: "resume", deviceId },
        random,
      }),
    ).toThrow(HandshakeError);
  });

  it("derives fresh session keys every time", () => {
    const first = pairedChannels();
    const second = pairedChannels();
    const frame = first.phone.sealJson("same");
    expect(() => second.desktop.openJson(frame)).toThrow(ChannelError);
  });
});

describe("SecureChannel", () => {
  it("rejects a replayed frame", () => {
    const { phone, desktop } = pairedChannels();
    const frame = phone.sealJson({ n: 1 });
    expect(desktop.openJson(frame)).toEqual({ n: 1 });
    expect(() => desktop.openJson(frame)).toThrow(ChannelError);
  });

  it("rejects dropped and reordered frames", () => {
    const { phone, desktop } = pairedChannels();
    const first = phone.sealJson(1);
    const second = phone.sealJson(2);
    expect(() => desktop.openJson(second)).toThrow(ChannelError);
    expect(desktop.openJson(first)).toBe(1);
    expect(desktop.openJson(second)).toBe(2);
  });

  it("rejects tampered ciphertext, tag, and counter", () => {
    const { phone, desktop } = pairedChannels();
    const frame = phone.sealJson({ type: "command" });
    for (const index of [0, 7, 8, frame.length - 1]) {
      const tampered = frame.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      expect(() => desktop.openJson(tampered)).toThrow(ChannelError);
    }
    expect(() => desktop.openJson(frame.subarray(0, 20))).toThrow(ChannelError);
    expect(desktop.openJson(frame)).toEqual({ type: "command" });
  });

  it("does not accept a frame reflected back to its sender", () => {
    const { phone } = pairedChannels();
    expect(() => phone.openJson(phone.sealJson("echo"))).toThrow(ChannelError);
  });

  it("rejects authenticated frames that are not JSON", () => {
    const { phone, desktop } = pairedChannels();
    expect(() => desktop.openJson(phone.seal(utf8Encode("{nope")))).toThrow(ChannelError);
  });
});

describe("keys", () => {
  it("rebuilds a key pair from its secret key", () => {
    const pair = generateKeyPair(webCryptoRandomBytes);
    expect(keyPairFromSecret(pair.secretKey).publicKey).toEqual(pair.publicKey);
    expect(() => keyPairFromSecret(new Uint8Array(31))).toThrow();
  });

  it("hashes secrets with SHA-256", async () => {
    const secret = random(32);
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(secret)));
    expect(hashSecret(secret)).toEqual(expected);
  });
});
