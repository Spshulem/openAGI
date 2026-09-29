// Read only the unencrypted TLS ClientHello routing name. Do not terminate TLS.
// This bounds the CONNECT route but cannot inspect encrypted HTTP authority.
export function inspectClientHelloSni(bytes, hostname) {
  if (bytes.length < 5) return "incomplete";
  if (bytes[0] !== 22 || bytes[1] !== 3) return "denied";
  const recordLength = bytes.readUInt16BE(3);
  if (recordLength < 42 || recordLength > 16_384) return "denied";
  if (bytes.length < recordLength + 5) return "incomplete";
  const record = bytes.subarray(5, recordLength + 5);
  if (record[0] !== 1 || record.length < 4) return "denied";
  const helloLength = record.readUIntBE(1, 3);
  if (helloLength + 4 !== record.length) return "denied";
  const body = record.subarray(4);
  let p = 34; // legacy version and 32-byte random
  if (p + 1 > body.length) return "denied";
  p += 1 + body[p]; // session id
  if (p + 2 > body.length) return "denied";
  p += 2 + body.readUInt16BE(p); // cipher suites
  if (p + 1 > body.length) return "denied";
  p += 1 + body[p]; // compression methods
  if (p + 2 > body.length) return "denied";
  const end = p + 2 + body.readUInt16BE(p);
  p += 2;
  if (end !== body.length) return "denied";
  let found = false;
  while (p < end) {
    if (p + 4 > end) return "denied";
    const type = body.readUInt16BE(p);
    const length = body.readUInt16BE(p + 2);
    p += 4;
    if (p + length > end || type === 0xfe0d) return "denied"; // encrypted ClientHello
    if (type === 0) {
      if (found || length < 5 || body.readUInt16BE(p) !== length - 2 || body[p + 2] !== 0) return "denied";
      const nameLength = body.readUInt16BE(p + 3);
      if (nameLength !== length - 5 || !body.subarray(p + 5, p + 5 + nameLength).equals(Buffer.from(hostname, "ascii"))) return "denied";
      found = true;
    }
    p += length;
  }
  return found ? "accepted" : "denied";
}
