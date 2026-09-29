import { PublicKey } from "@solana/web3.js";

/**
 * Minimal Borsh codec driven by an Anchor IDL (docs/specs/crash-client-v1.md §3). It supports
 * exactly the type grammar the crash program uses and throws on anything else, so an IDL change
 * that introduces a new shape fails loudly instead of decoding garbage.
 */

export type IdlType =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "bool"
  | "pubkey"
  | "string"
  | { array: [IdlType, number] }
  | { option: IdlType }
  | { defined: { name: string } };

export interface IdlField {
  name: string;
  type: IdlType;
}

export type IdlTypeDef =
  | { name: string; type: { kind: "struct"; fields: IdlField[] } }
  | { name: string; type: { kind: "enum"; variants: { name: string }[] } };

export type TypeRegistry = ReadonlyMap<string, IdlTypeDef>;

/** Decoded value: `u64` → bigint, `[u8; N]` → Uint8Array, option → value | null, enum → variant name. */
export type Decoded =
  | number
  | bigint
  | boolean
  | string
  | null
  | PublicKey
  | Uint8Array
  | Decoded[]
  | { [key: string]: Decoded };

const U64_MAX = (1n << 64n) - 1n;

export class BorshReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position(): number {
    return this.offset;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error(`Borsh: unexpected end of data at offset ${this.offset} (+${length})`);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  bytesFixed(length: number): Uint8Array {
    return Uint8Array.from(this.take(length));
  }

  u8(): number {
    return this.take(1)[0];
  }

  u16(): number {
    const start = this.offset;
    this.take(2);
    return this.view.getUint16(start, true);
  }

  u32(): number {
    const start = this.offset;
    this.take(4);
    return this.view.getUint32(start, true);
  }

  u64(): bigint {
    const start = this.offset;
    this.take(8);
    return this.view.getBigUint64(start, true);
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new Error(`Borsh: invalid bool ${value}`);
    return value === 1;
  }

  pubkey(): PublicKey {
    return new PublicKey(this.take(32));
  }

  string(): string {
    const length = this.u32();
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
  }
}

export class BorshWriter {
  private readonly chunks: Uint8Array[] = [];

  bytes(value: Uint8Array): void {
    this.chunks.push(Uint8Array.from(value));
  }

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`Borsh: invalid u8 ${value}`);
    this.chunks.push(Uint8Array.of(value));
  }

  u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`Borsh: invalid u16 ${value}`);
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    this.chunks.push(out);
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`Borsh: invalid u32 ${value}`);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    this.chunks.push(out);
  }

  u64(value: bigint): void {
    if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new Error(`Borsh: invalid u64 ${String(value)}`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    this.chunks.push(out);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  pubkey(value: PublicKey): void {
    this.bytes(value.toBytes());
  }

  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  toBytes(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function lookup(types: TypeRegistry, name: string): IdlTypeDef {
  const def = types.get(name);
  if (!def) throw new Error(`Borsh: unknown IDL type ${name}`);
  return def;
}

export function decodeType(reader: BorshReader, type: IdlType, types: TypeRegistry): Decoded {
  if (typeof type === "string") {
    switch (type) {
      case "u8":
        return reader.u8();
      case "u16":
        return reader.u16();
      case "u32":
        return reader.u32();
      case "u64":
        return reader.u64();
      case "bool":
        return reader.bool();
      case "pubkey":
        return reader.pubkey();
      case "string":
        return reader.string();
    }
  }
  if ("array" in type) {
    const [inner, length] = type.array;
    if (inner === "u8") return reader.bytesFixed(length);
    return Array.from({ length }, () => decodeType(reader, inner, types));
  }
  if ("option" in type) {
    const tag = reader.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new Error(`Borsh: invalid option tag ${tag}`);
    return decodeType(reader, type.option, types);
  }
  if ("defined" in type) {
    return decodeDefined(reader, lookup(types, type.defined.name), types);
  }
  throw new Error(`Borsh: unsupported IDL type ${JSON.stringify(type)}`);
}

export function decodeDefined(reader: BorshReader, def: IdlTypeDef, types: TypeRegistry): Decoded {
  if (def.type.kind === "struct") {
    const out: { [key: string]: Decoded } = {};
    for (const field of def.type.fields) out[snakeToCamel(field.name)] = decodeType(reader, field.type, types);
    return out;
  }
  const index = reader.u8();
  const variant = def.type.variants[index];
  if (!variant) throw new Error(`Borsh: invalid ${def.name} variant ${index}`);
  return variant.name;
}

/** Encodes `value` (camelCase keys for structs) following `type`. */
export function encodeType(writer: BorshWriter, type: IdlType, value: unknown, types: TypeRegistry): void {
  if (typeof type === "string") {
    switch (type) {
      case "u8":
        return writer.u8(value as number);
      case "u16":
        return writer.u16(value as number);
      case "u32":
        return writer.u32(value as number);
      case "u64":
        return writer.u64(value as bigint);
      case "bool":
        if (typeof value !== "boolean") throw new Error("Borsh: expected boolean");
        return writer.bool(value);
      case "pubkey":
        if (!(value instanceof PublicKey)) throw new Error("Borsh: expected PublicKey");
        return writer.pubkey(value);
      case "string":
        if (typeof value !== "string") throw new Error("Borsh: expected string");
        return writer.string(value);
    }
  }
  if ("array" in type) {
    const [inner, length] = type.array;
    if (inner === "u8") {
      if (!(value instanceof Uint8Array) || value.length !== length) {
        throw new Error(`Borsh: expected ${length} bytes`);
      }
      return writer.bytes(value);
    }
    if (!Array.isArray(value) || value.length !== length) throw new Error(`Borsh: expected array of ${length}`);
    for (const item of value) encodeType(writer, inner, item, types);
    return;
  }
  if ("option" in type) {
    if (value === null || value === undefined) return writer.u8(0);
    writer.u8(1);
    return encodeType(writer, type.option, value, types);
  }
  if ("defined" in type) {
    const def = lookup(types, type.defined.name);
    if (def.type.kind === "struct") {
      const record = value as Record<string, unknown>;
      for (const field of def.type.fields) encodeType(writer, field.type, record[snakeToCamel(field.name)], types);
      return;
    }
    const index = def.type.variants.findIndex((variant) => variant.name === value);
    if (index < 0) throw new Error(`Borsh: invalid ${def.name} variant ${String(value)}`);
    return writer.u8(index);
  }
  throw new Error(`Borsh: unsupported IDL type ${JSON.stringify(type)}`);
}

export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}
