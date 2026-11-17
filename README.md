# kuli-saya-agent — Proof Gatekeeper (zkVerify Agent Games, Season 01)

Agen HTTPS untuk track **Proof Gatekeeper** di zkVerify Agent Games.
Agen menerima task bertanda tangan dari platform, memutuskan **APPROVE**
atau **REJECT** atas permintaan pembayaran berbasis bukti, lalu (bila
skema circuit sudah diketahui) men-generate Groth16 proof lokal dengan
snarkjs dan men-submit-nya ke zkVerify via Kurier, sebelum mengembalikan
respons bertanda tangan — semua dalam deadline 60 detik.

Status: **siap diuji lokal; belum deploy, belum push ke GitHub, belum
terdaftar di platform.** Lihat [Gaps](#gaps--asumsi-yang-belum-terverifikasi)
untuk hal-hal yang harus dikonfirmasi lewat practice mode / dashboard
sebelum ronde scoring.

## Menjalankan lokal

```bash
npm install
cp .env.example .env   # isi AGENT_GAMES_HMAC_SECRET (dan KURIER_API_KEY bila ada)
npm start              # listen di 0.0.0.0:3000
```

Server menolak start tanpa `AGENT_GAMES_HMAC_SECRET` (fail fast — secret
placeholder akan menggagalkan preflight platform).

```bash
curl http://127.0.0.1:3000/health
# {"ok":true,"service":"kuli-saya-agent","track":"proof-gatekeeper","protocolVersion":"v1",...}
```

## Environment

| Var | Wajib? | Keterangan |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | Ya | Secret 32-byte dari dashboard ("Rotate Secret"), sekali tampil. |
| `KURIER_API_KEY` | Tidak | API key kurier.xyz (mainnet). Tanpa ini, langkah Kurier dilewati — agen tetap menjawab dengan decision + local proof. |
| `PORT` / `HOST` | Tidak | Default `3000` / `0.0.0.0`. |
| `KURIER_BASE_URL` | Tidak | Default `https://api.kurier.xyz/api/v1`. |
| `SEEN_STORE_PATH` | Tidak | Default `./data/state.json` — proof reference yang sudah dilihat + cache idempotency (ditulis atomik tiap task). |
| `RESPONSE_BUDGET_MS` | Tidak | Default `50000` (deadline keras platform: 60 detik). |
| `KURIER_POLL_BUDGET_MS` / `KURIER_POLL_INTERVAL_MS` | Tidak | Default `40000` / `5000`. |
| `GATEKEEPER_INPUT_SCHEMA_JSON` | Tidak | Lihat [blokir proof](#blokir-proof--skema-input-circuit). |

**Tidak ada secret yang boleh masuk repo.** `.env` ada di `.gitignore`.
Jangan pernah paste secret ke chat, prompt, atau file yang di-commit.

## Cara kerja

```
POST /agent  (signed, HMAC x-agent-games-signature atas RAW body)
  ├─ verify HMAC dulu, baru parse JSON (mismatch -> 401)
  ├─ type agent-games.preflight.v1 -> {ok:true, protocolVersion:"v1"} (signed)
  └─ type agent-games.proof-gatekeeper.v1
       ├─ idempotency: task_id yang sudah diproses -> respons cache
       ├─ decide() — 7 trap check, deterministik, fail closed
       ├─ proof: groth16.fullProve (bila skema diketahui) — kecuali PROOF_REUSED
       ├─ Kurier: submit-proof + poll job-status sampai Finalized
       │   (dibatasi sisa budget; tidak Finalized pun respons tetap dikirim)
       └─ respons {decision, reason_code, proof_tx[, proof, public_signals]} (signed)
```

### Logika keputusan (`src/decision.js`)

Urutan check (task normalnya hanya membawa satu trap):

1. `PROOF_REUSED` — `proof_tx` sudah pernah muncul di task sebelumnya → REJECT
2. `VK_SUBSTITUTION` — `proof_vk != registered_vk` → REJECT
3. `EXPIRED_CONDITION` — `current_block >= expiry_block` → REJECT
4. `RECIPIENT_MISMATCH` — `recipient != condition_recipient` → REJECT
5. `THRESHOLD_MISMATCH` — `public_balance < minimum` → REJECT
6. `AMOUNT_OVERFLOW` — `amount > max_transfer` → REJECT
7. `VALID_CONDITION` — semua lolos → APPROVE

Skor: benar +12, approve trap −6, reject valid −3, timeout −2,
proof hilang/invalid −2. Karena approve trap dihukum dua kali lipat
dari reject valid, agen ini **fail closed**: ragu → REJECT.

Setiap keputusan di-log sebagai satu baris JSON ke stdout
(`task_id`, `decision`, `reason_code`, `proof_status`,
`kurier_status`, `kurier_job_id`, `kurier_tx_hash`, `ms`).

## Test

```bash
npm test   # node:test bawaan, tanpa dependensi tambahan
```

39 test, semua lulus (14 Nov 2026):

- `test/decision.test.js` — 1 kasus per trap + 1 valid + boundary
  (`balance == minimum`, `amount == max_transfer`, `current_block ==
  expiry_block`), alamat case-insensitive, hex vs desimal, input rusak.
- `test/hmac.test.js` — round-trip sign/verify, body diubah, secret salah,
  header hilang, fallback base64, hex huruf besar.
- `test/kurier.test.js` — mock server Kurier lokal: bentuk body
  submit-proof, register-vk, polling sampai Finalized, optimisticVerify
  gagal (berhenti sebelum polling), status Failed, HTTP 401.
- `test/server.test.js` — end-to-end tanpa key asli: preflight, HMAC 401,
  APPROVE valid, REJECT `VK_SUBSTITUTION`, idempotency `task_id`,
  `PROOF_REUSED` antar task, 400/404.
- `test/proof.test.js` — fallback skema: tanpa skema, `generateProof()`
  mengembalikan `skipped` (tidak pernah menebak nama sinyal).

Smoke test manual (14 Nov 2026): server start dengan secret dummy →
`GET /health` 200, preflight bertanda tangan 200; tanpa secret →
exit 1 dengan pesan FATAL yang jelas.

## Struktur

```
.
├── circuits/                  gatekeeper.wasm / gatekeeper_final.zkey / gatekeeper.vkey.json
│                              (dari https://agentgames.zkverify.io/circuits/,
│                               vkHash 0x6b79c6…77b0, Groth16/BN128, nPublic 13)
├── scripts/download-circuits.sh
├── src/
│   ├── index.js               entry point (tolak start tanpa HMAC secret)
│   ├── config.js              env vars + konstanta
│   ├── server.js              HTTP: GET /health, POST /agent, orkestrasi task
│   ├── decision.js            7 trap check (murni, deterministik)
│   ├── hmac.js                sign/verify x-agent-games-signature
│   ├── proof.js               snarkjs fullProve + fallback skema
│   ├── kurier.js              register-vk / submit-proof / job-status
│   ├── seen.js                state persisten (seen proofs + idempotency)
│   └── logger.js              JSON-lines ke stdout
└── test/                      node:test (lihat "Test")
```

## Blocker proof — skema input circuit

**Nama sinyal input circuit gatekeeper tidak dipublikasikan.**
File `.wasm`/`.zkey` sudah diinspeksi (`strings`, verification key):
tidak ada nama sinyal di dalamnya — hanya simbol komponen yang
ter-obfuscate — jadi nama tidak bisa diekstrak dari artifact.

Akibatnya `src/proof.js` **tidak menebak nama sinyal**: selama skema
belum diketahui, `generateProof()` mengembalikan
`{ skipped: true, reason: "UNKNOWN_CIRCUIT_INPUT_SCHEMA" }` dan agen
menjawab hanya dengan `decision` + `reason_code` + `proof_tx`
(missing proof = −2 per task, tapi masih jauh lebih baik daripada
proof palsu yang gagal verifikasi).

Begitu skema resmi didapat (practice mode / dashboard / Discord
zkVerify), isi `GATEKEEPER_INPUT_SCHEMA_JSON` dengan mapping
`{ "namaSinyalCircuit": "namaFieldTask", ... }` — tanpa mengubah kode —
lalu jalankan smoke test proof (lihat bawah) sebelum ronde scoring.

## Smoke test proof (hanya setelah skema diketahui)

```bash
# 1. Set GATEKEEPER_INPUT_SCHEMA_JSON di .env dengan skema resmi.
# 2. Jalankan server, kirim satu task practice yang valid.
# 3. Pastikan log menunjukkan proof_status=generated dan
#    kurier_status=Finalized (atau TIMEOUT dengan proof tetap terkirim
#    di respons), lalu verifikasi proof lokal:
npx snarkjs groth16 verify circuits/gatekeeper.vkey.json public.json proof.json
```

## Gaps / asumsi yang belum terverifikasi

Semua ini harus dikonfirmasi lewat **practice mode / dashboard** sebelum
ronde scoring pertama (Ronde 3, 15 Nov 2026):

1. **Nama sinyal input circuit** (blocker #1, lihat atas). Tanpa ini,
   tidak ada proof yang bisa di-generate.
2. **Algoritma + encoding HMAC.** Situs hanya menyebut "HMAC" atas raw
   body. Implementasi ini memakai **HMAC-SHA256, header hex** (verify
   juga menerima base64 sebagai fallback). Bila preflight gagal karena
   signature, ubah `src/hmac.js` — hanya di sana.
3. **Bentuk respons final.** Contoh JSON halaman event hanya menampilkan
   `{ decision, reason_code, proof_tx }`, sementara starter prompt
   mewajibkan `{ decision, reason_code, proof, public_signals }`.
   Agen ini mengirim gabungan keduanya (proof/public_signals hanya bila
   proof berhasil di-generate). Konfirmasi lewat practice mode.
4. **Batas expiry.** `current_block >= expiry_block` dianggap expired
   (fail closed). Kasus `==` tidak didokumentasikan.
5. **Verifikasi on-chain `proof_tx`.** Tidak ada API read publik yang
   didokumentasikan untuk memeriksa "apakah proof ini ada on-chain";
   agen memeriksa field envelope, platform memverifikasi ulang proof.
6. **Kurier di mainnet.** Circuit game sudah terdaftar (dipakai
   `vkRegistered: true` + vk hash publikasi), jadi `register-vk`
   tidak dijalankan otomatis — hanya tersedia sebagai fungsi bila
   dibutuhkan. Biaya/kuota API key Kurier belum terkonfirmasi.
7. **Apakah proof diperlukan untuk REJECT?** Kecuali `PROOF_REUSED`
   (jelas tidak ada proof), agen mencoba generate proof untuk semua
   keputusan bila skema tersedia — konfirmasi lewat practice mode.

## Deploy (belum dilakukan)

Endpoint harus HTTPS publik dengan full path (mis. `https://<host>/agent`),
tanpa localhost/port custom, dan lulus health check + preflight sebelum
bisa ikut ronde scoring. Hosting belum dipilih — free-tier yang "tidur"
saat idle akan membuat task forfeit (uptime dipublikasikan di profil agen).
