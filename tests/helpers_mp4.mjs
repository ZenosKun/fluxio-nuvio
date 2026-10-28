/**
 * Builder de MP4 synthétique partagé par les tests (test_units, test_verify).
 * ftyp + moov[trak[tkhd]] + mdat — faststart, width 1920, hauteur paramétrée.
 * tkhd v0 : 8 (hdr) + 4 (ver/flags) + 80 (payload) = 92 o ; v1 = 104 o.
 * width/height = 8 DERNIERS octets, virgule fixe 16.16.
 */
export function buildMp4(height, opts = {}) {
    const v = opts.version || 0;
    const bytes = [];
    const u32 = n => bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    const u16 = n => bytes.push((n >>> 8) & 0xff, n & 0xff);
    const u64 = () => { for (let i = 0; i < 8; i++) bytes.push(0); };
    const ascii = s => { for (const c of s) bytes.push(c.charCodeAt(0)); };
    // ftyp (20 o : size+type+major brand+minor version+compatible brands)
    u32(20); ascii('ftyp'); ascii('isom'); u32(0x200); ascii('isom');
    // moov (taille patchée à la fin)
    const moovStart = bytes.length;
    u32(0); ascii('moov');
    // trak (taille patchée à la fin)
    const trakStart = bytes.length;
    u32(0); ascii('trak');
    // tkhd
    const payload = v === 0 ? 80 : 92;
    u32(12 + payload); ascii('tkhd');
    u32(v === 0 ? 0 : 0x01000000); // version + flags
    if (v === 0) { u32(0); u32(0); } // creation, modification (u32)
    else { u64(); u64(); } // creation, modification (u64)
    u32(1); u32(0); // track_ID, reserved
    if (v === 0) u32(4000); else u64(); // duration
    u32(0); u32(0); // reserved[2] (u32 x2)
    u16(0); u16(0); u16(0x0100); u16(0); // layer, alternate_group, volume, reserved
    for (let i = 0; i < 36; i++) bytes.push(0); // matrix
    u32(1920 * 65536); u32(height * 65536); // width, height (16.16)
    // patch tailles parentes (trak, moov)
    const tkhdEnd = bytes.length;
    const trakSize = tkhdEnd - trakStart;
    bytes[trakStart] = (trakSize >>> 24) & 0xff; bytes[trakStart + 1] = (trakSize >>> 16) & 0xff;
    bytes[trakStart + 2] = (trakSize >>> 8) & 0xff; bytes[trakStart + 3] = trakSize & 0xff;
    const moovSize = tkhdEnd - moovStart;
    bytes[moovStart] = (moovSize >>> 24) & 0xff; bytes[moovStart + 1] = (moovSize >>> 16) & 0xff;
    bytes[moovStart + 2] = (moovSize >>> 8) & 0xff; bytes[moovStart + 3] = moovSize & 0xff;
    // mdat
    bytes.push(0, 0, 0, 24); ascii('mdat'); for (let i = 0; i < 16; i++) bytes.push(0xff);
    return new Uint8Array(bytes);
}
