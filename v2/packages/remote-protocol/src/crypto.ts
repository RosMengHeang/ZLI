import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  concatBytes,
  counterBytes,
  equalBytes,
  fromBase64Url,
  type RandomBytes,
  readCounter,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "./bytes.js";
import { type ClientHello, REMOTE_PROTOCOL_VERSION, type ServerWelcome } from "./messages.js";

/*
 * The handshake, in the style of Noise KK with a pre-shared key:
 *
 *   phone  -> desktop  hello: mode, pairing or device id, phone static key S_p, ephemeral key E_p, proof
 *   desktop -> phone   welcome: ephemeral key E_d, proof
 *
 * es = DH(E_p, S_d) and ss = DH(S_p, S_d) authenticate both static keys; ee = DH(E_p, E_d) makes the
 * session keys forward secret. When pairing, the one-time pairing secret is the HKDF salt, so only a
 * phone that read the QR code can produce a valid proof. Resumed sessions use a zero salt and send the
 * device credential inside the encrypted channel afterwards, so the desktop only has to store its hash.
 */

const LABEL = "zli-remote/1";
const ZERO_SALT = new Uint8Array(32);
const TAG_BYTES = 16;
const HEADER_BYTES = 8;

export type KeyPair = { secretKey: Uint8Array; publicKey: Uint8Array };

export class HandshakeError extends Error {
  override name = "HandshakeError";
}

export class ChannelError extends Error {
  override name = "ChannelError";
}

export function generateKeyPair(random: RandomBytes): KeyPair {
  return keyPairFromSecret(random(32));
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== 32) throw new Error("An X25519 secret key is 32 bytes.");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function hashSecret(secret: Uint8Array): Uint8Array {
  return sha256(secret);
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    // noble rejects low-order points, whose shared secret would be all zeros.
    return x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    throw new HandshakeError("The key exchange failed.");
  }
}

function key32(value: string): Uint8Array {
  const bytes = fromBase64Url(value);
  if (bytes.length !== 32) throw new HandshakeError("A key has the wrong length.");
  return bytes;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(bytes.length), bytes);
}

function helloTranscript(
  hello: Pick<ClientHello, "mode"> & { id: string },
  serverStatic: Uint8Array,
  clientStatic: Uint8Array,
  clientEphemeral: Uint8Array,
): Uint8Array {
  return sha256(
    concatBytes(
      utf8Encode(`${LABEL} hello`),
      Uint8Array.of(hello.mode === "pair" ? 1 : 2),
      lengthPrefixed(utf8Encode(hello.id)),
      serverStatic,
      clientStatic,
      clientEphemeral,
    ),
  );
}

function helloProof(es: Uint8Array, ss: Uint8Array, psk: Uint8Array, transcript: Uint8Array): Uint8Array {
  const key = hkdf(sha256, concatBytes(es, ss), psk, concatBytes(utf8Encode(`${LABEL} client proof`), transcript), 32);
  return hmac(sha256, key, transcript);
}

type SessionSecrets = { clientKey: Uint8Array; serverKey: Uint8Array; serverProof: Uint8Array };

function sessionSecrets(
  es: Uint8Array,
  ss: Uint8Array,
  ee: Uint8Array,
  psk: Uint8Array,
  transcript: Uint8Array,
  serverEphemeral: Uint8Array,
): SessionSecrets {
  const finalTranscript = sha256(concatBytes(transcript, serverEphemeral));
  const okm = hkdf(
    sha256,
    concatBytes(es, ss, ee),
    psk,
    concatBytes(utf8Encode(`${LABEL} session`), finalTranscript),
    96,
  );
  const confirmKey = okm.slice(64, 96);
  return {
    clientKey: okm.slice(0, 32),
    serverKey: okm.slice(32, 64),
    serverProof: hmac(sha256, confirmKey, concatBytes(utf8Encode("server"), finalTranscript)),
  };
}

export type HandshakeTarget =
  | { mode: "pair"; pairingId: string; pairingSecret: Uint8Array }
  | { mode: "resume"; deviceId: string };

/** The phone's side: builds the hello, then checks the welcome and derives the channel. */
export function startClientHandshake(options: {
  serverPublicKey: Uint8Array;
  clientStatic: KeyPair;
  target: HandshakeTarget;
  random: RandomBytes;
}): { hello: ClientHello; finish(welcome: ServerWelcome): SecureChannel } {
  const { serverPublicKey, clientStatic, target } = options;
  if (serverPublicKey.length !== 32) throw new HandshakeError("The desktop key has the wrong length.");
  const ephemeral = generateKeyPair(options.random);
  const id = target.mode === "pair" ? target.pairingId : target.deviceId;
  const psk = target.mode === "pair" ? target.pairingSecret : ZERO_SALT;
  if (psk.length !== 32) throw new HandshakeError("The pairing secret has the wrong length.");
  const transcript = helloTranscript(
    { mode: target.mode, id },
    serverPublicKey,
    clientStatic.publicKey,
    ephemeral.publicKey,
  );
  const es = dh(ephemeral.secretKey, serverPublicKey);
  const ss = dh(clientStatic.secretKey, serverPublicKey);
  const proof = toBase64Url(helloProof(es, ss, psk, transcript));
  const common = {
    type: "hello" as const,
    protocol: REMOTE_PROTOCOL_VERSION,
    clientStatic: toBase64Url(clientStatic.publicKey),
    clientEphemeral: toBase64Url(ephemeral.publicKey),
    proof,
  };
  const hello: ClientHello =
    target.mode === "pair"
      ? { ...common, mode: "pair", pairingId: target.pairingId }
      : { ...common, mode: "resume", deviceId: target.deviceId };
  return {
    hello,
    finish(welcome) {
      const serverEphemeral = key32(welcome.serverEphemeral);
      const ee = dh(ephemeral.secretKey, serverEphemeral);
      const secrets = sessionSecrets(es, ss, ee, psk, transcript, serverEphemeral);
      if (!equalBytes(secrets.serverProof, key32(welcome.proof))) {
        throw new HandshakeError("The desktop could not prove its key.");
      }
      return new SecureChannel(secrets.clientKey, secrets.serverKey);
    },
  };
}

/**
 * The desktop's side. `psk` is the pairing secret for a pair hello and undefined for a resume hello.
 * Throws HandshakeError when the proof does not verify.
 */
export function acceptClientHello(options: {
  hello: ClientHello;
  serverStatic: KeyPair;
  psk?: Uint8Array | undefined;
  random: RandomBytes;
}): { welcome: ServerWelcome; channel: SecureChannel; clientStatic: Uint8Array } {
  const { hello, serverStatic } = options;
  const psk = hello.mode === "pair" ? options.psk : ZERO_SALT;
  if (psk?.length !== 32) throw new HandshakeError("No pairing secret for this hello.");
  const clientStatic = key32(hello.clientStatic);
  const clientEphemeral = key32(hello.clientEphemeral);
  const id = hello.mode === "pair" ? hello.pairingId : hello.deviceId;
  const transcript = helloTranscript({ mode: hello.mode, id }, serverStatic.publicKey, clientStatic, clientEphemeral);
  const es = dh(serverStatic.secretKey, clientEphemeral);
  const ss = dh(serverStatic.secretKey, clientStatic);
  if (!equalBytes(helloProof(es, ss, psk, transcript), key32(hello.proof))) {
    throw new HandshakeError("The hello proof did not verify.");
  }
  const ephemeral = generateKeyPair(options.random);
  const ee = dh(ephemeral.secretKey, clientEphemeral);
  const secrets = sessionSecrets(es, ss, ee, psk, transcript, ephemeral.publicKey);
  return {
    welcome: {
      type: "welcome",
      protocol: REMOTE_PROTOCOL_VERSION,
      serverEphemeral: toBase64Url(ephemeral.publicKey),
      proof: toBase64Url(secrets.serverProof),
    },
    channel: new SecureChannel(secrets.serverKey, secrets.clientKey),
    clientStatic,
  };
}

/**
 * ChaCha20-Poly1305 frames: an 8-byte counter, then ciphertext and tag. Each direction has its own
 * key and counts from zero, so the counter is a unique nonce, and the receiver accepts only the next
 * number, which rejects replayed, dropped, and reordered frames.
 */
export class SecureChannel {
  readonly #sendKey: Uint8Array;
  readonly #receiveKey: Uint8Array;
  #sent = 0;
  #received = 0;

  constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    this.#sendKey = sendKey;
    this.#receiveKey = receiveKey;
  }

  seal(plaintext: Uint8Array): Uint8Array {
    const header = counterBytes(this.#sent);
    this.#sent += 1;
    return concatBytes(header, chacha20poly1305(this.#sendKey, nonceFor(header), header).encrypt(plaintext));
  }

  open(frame: Uint8Array): Uint8Array {
    if (frame.length < HEADER_BYTES + TAG_BYTES) throw new ChannelError("The frame is too short.");
    const header = frame.subarray(0, HEADER_BYTES);
    if (readCounter(header) !== this.#received) throw new ChannelError("The frame is out of order or repeated.");
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#receiveKey, nonceFor(header), header).decrypt(frame.subarray(HEADER_BYTES));
    } catch {
      throw new ChannelError("The frame did not authenticate.");
    }
    this.#received += 1;
    return plaintext;
  }

  sealJson(value: unknown): Uint8Array {
    return this.seal(utf8Encode(JSON.stringify(value)));
  }

  openJson(frame: Uint8Array): unknown {
    const text = utf8Decode(this.open(frame));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ChannelError("The frame is not JSON.");
    }
  }
}

function nonceFor(header: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array(4), header);
}
