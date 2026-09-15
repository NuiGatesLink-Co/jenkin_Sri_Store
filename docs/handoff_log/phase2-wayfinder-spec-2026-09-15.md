# Handoff — Phase 2: map + spec (wayfinder, 2026-09-15 กลางคืน)

**ผู้บันทึก:** Claude (orchestrator) แทน NuimanLP ที่ไปนอน · **สถานะ:** spec merge แล้ว · **ยังไม่ออก ticket**
**ต่อจาก:** [`session-2026-09-15-phase1-closeout.md`](session-2026-09-15-phase1-closeout.md), [`lane-a-closeout-round-2026-09-15.md`](lane-a-closeout-round-2026-09-15.md)

## 1. ตอนนี้อยู่ตรงไหน
- **map:** [#243 Phase 2 — offline shell to cutover](https://github.com/NuimanLP/srisurart-pos-flutter/issues/243) (`wayfinder:map`) · ปลายทาง = spec พร้อมลงมือ สำหรับ production ในมหาลัย (`mob04`)
- **การตัดสินใจทั้งหมด:** [#240](https://github.com/NuimanLP/srisurart-pos-flutter/issues/240) — D1–D15 ในตัว issue · E1–E11 · F1–F10 · **F4′** ในคอมเมนต์ (ข้อหลังชนะข้อก่อน)
- **spec:** `docs/Backend_design/08_PHASE2_SPEC.md` — **PR #254 merge แล้ว** (`1072f17`) · ADR-0004/0007/0009/0010/0013 มี addendum ลงวันที่
- **research:** #241 PWA (branch `research/pwa-offline-shell`) · #242 host (branch `research/production-host`) — ปิดทั้งคู่
- **bug ที่เจอระหว่างทาง:** #245 web asset skew (`pubspec.lock` sqlite3 3.4.0 / drift 2.34.1 vs asset 3.3.3 / 2.34.0)
- **ยังไม่ทำ:** ออก ticket ตาม 08 §16 → ดูข้อ 5

## 2. ตัดสินใจอะไรไป (ย่อ — ตัวจริงอยู่ที่ #240)
| เรื่อง | ผล |
|---|---|
| บทบาท | role `owner` เดียว + **บัญชีร้านเดียว** · เครื่องยังแบ่ง `pos` / `backoffice` |
| void | ออนไลน์ = เหตุผลอย่างเดียว ไม่มี PIN · ออฟไลน์เฉพาะบิลที่ขายตอนออฟไลน์ → รายการรอ owner |
| ออฟไลน์ | ไม่มี `offlineOk` · `pos` ออกเลข RC/CN เอง · outbox: ขาย/คืน/ลิ้นชัก/เปิดกะ/ชำระเครดิต/ลูกค้า/void/override วงเงิน · ที่เหลือออนไลน์ · พักบิลอยู่ในเครื่อง |
| กะ | หลายกะต่อวัน · ปิดกะต้องออนไลน์ + คิวว่าง · กะค้างขึ้นป้าย "ยังไม่นับเงิน" |
| sync (B1–B4) | replay ก่อนตรวจ · client id ทุก op · ส่งตามลำดับ หยุดที่ non-verdict (ล้ม 3 ครั้ง → รอ owner) · cursor ของ server |
| PIN ออฟไลน์ | 1 อันต่อเครื่อง `pos` · ไม่ซ้ำรหัสผ่าน · 3 วัน ตรวจที่เครื่องเท่านั้น |
| เครื่อง | retire/enrol/export ต้องมี device token · ห้าม retire ถ้ามี op ค้าง (มีปุ่มบังคับ) · ล้าง storage = `device_no` ใหม่เสมอ |
| production | `mob04` เดียว ในมหาลัย · backup `pg_dump --create` รายวัน · deploy = **self-hosted runner ของ #237 (F4′)** · ร้านจริง = เฟสถัดไป |
| หน้า | "รอ owner" หน้าเดียว 2 แท็บ |

## 3. ลองแล้วไม่เวิร์ก / เปลี่ยนใจ
- **3 role → owner+staff → owner เดียว + บัญชีเดียว** (เจ้าของอยาก simple) — spec เขียนใหม่ 3 รอบ
- **E11 runner → F4 pull-based → F4′ runner ของ #237:** รีวิวรอบ 2 เตือนว่า fork PR รันบน production ได้ แต่ #237 (merge 13:20 จาก session อื่น) ปิดช่องด้วย job-started hook + `pos-deploy` wrapper แล้ว
- **`/to-tickets` เรียกผ่าน agent ไม่ได้** — skill ตั้ง `disable-model-invocation` ต้องให้คนพิมพ์เอง

## 4. รีวิวที่ผ่าน
- รอบ 1 (Opus scrutinize + code-review): 🔴 4 ข้อ (replay ก่อนตรวจ, TTL key 24 ชม. < 3 วัน, retry กลางชุด, cursor ใช้นาฬิกาเครื่อง) — แก้แล้ว
- รอบ 2 (Opus): 🔴 3 ข้อ (push ไม่มี user, คิวค้างถาวร, runner บน repo public) — แก้แล้ว
- รอบ 3 (Sonnet verify): 0 ค้าง · merge `main` เข้า branch แล้วเช็ค PR ใหม่ 11 ตัวว่าไม่ขัด · CI เขียว

## 5. 🔴 ก้าวถัดไป — ออก ticket แบบ "lane ใครlaneมัน" (เจ้าของสั่งก่อนนอน)
**ข้อกำหนดของเจ้าของ:** แต่ละ lane ทำงานของตัวเองจบได้ **ไม่ต้องรอใคร ไม่ยุ่งกับ lane อื่น** · กติกาคอร์ส: ทุกคนต้องแตะ frontend + backend + CI/CD

**ปัญหาเชิงโครงสร้างที่ต้องเคาะ:** slice 8 (#228 outbox + `/sync/push`) เป็นศูนย์กลาง — slice 9–17, 19, 20 รอมันทั้งหมด จึงแบ่ง "ไม่รอกันเลย" แบบเท่า ๆ กันไม่ได้ มี 2 ทาง:

**ทาง A — lane 1 ถือเส้นออฟไลน์ทั้งเส้น (ไม่มีใครรอใครจริง แต่ไม่เท่ากัน)**
| lane | slice (08 §16) | FE / BE / CI |
|---|---|---|
| `team/1` NuimanLP — sync + เงิน | 3 `pwa.1` · 4 `num.1` · 5 #189 · 6 `review.1` · 7 `shift.multi` · 8 #228 · 9 `q2.cp` · 10 #211 · 11 `q2.void` · 12 #229 · 13b #212B · 14 #194 · 15 #190 · 16 #230 · 17 `dev.retire-guard` · 19 #195 · 20 #193 | ครบ (20 = CI) |
| `team/2` LomerAlloys — client shell + catalogue | 0a #245 · 0b `fe.fonts` · 18 `fe.drop-offlineok` · 13a #212A (keyset server) · 1 `role.1` | FE 0b/18 · BE 13a/1 · CI 0a (assertion asset) |
| `team/3` PattaraponKitcharoen — platform + ops | 2 `sec.device-gate` · 21 #192 · 22 #184 · 23 `ops.backup` · 24 `sec.platform-allowlist` · 25 #67 | BE 2/24 · FE 21 · CI/ops 22/23/25 |

จุดข้าม lane ที่ต้องตัดใน ticket: 11 รอ 1 (void เหตุผล) → lane 1 ทำ 11 ท้ายสุด หรือย้าย `role.1` เข้า lane 1 · 17 รอ 2 → ย้าย 2 เข้า lane 1 · 21 รอ 4 → เขียน AC ของ 21 ให้ไม่พึ่ง `num.1` (แค่ `device_no` ใหม่เสมอ)

**ทาง B — contract ก่อน (เท่ากันกว่า รอสั้นครั้งเดียว)**
lane 1 ส่ง `sync.contract` เล็ก ๆ ก่อน (ตาราง outbox ใน Drift + รูป op + `/sync/push` stub ที่ตอบ `retry` + fake SyncService สำหรับเทสต์) แล้วแบ่ง op type ออกไป: lane 2 ถือ 12 #229 + 13b + 19 #195 · lane 3 ถือ 10 #211 + 17 + 21 · ที่เหลือตามทาง A

**สิ่งที่ต้องทำพรุ่งนี้ (เจ้าของ):**
1. เลือกทาง A หรือ B (หรือปรับ)
2. พิมพ์ `/to-tickets` แล้วชี้มาที่ไฟล์นี้ + 08 §16 — แก้ ticket เดิม (#189 #190 #192–#195 #211 #212 #228–#230 #184 #67 #245) ให้ตรง 08, เปิด ticket NEW, ผูกเป็น sub-issue ของ #243 + blocked-by **เฉพาะภายใน lane**, ติดป้าย `team/N`
3. ticket ข้อความไทย `copy.phase2` (F10): agent ร่างข้อละ 2–3 แบบ เจ้าของเลือก
4. ติดตั้ง runner บน `mob04` ตาม `07 §6.2` (#67) และ #184 deploy + วัด RAM ภายใต้โหลด

## 6. ข้อควรระวัง
- 🔴 **08 ชนะเอกสารเก่า** เรื่องเฟส 2 · ถ้า 08 ขัดกับ ADR ให้เช็ค addendum ลงวันที่ 2026-09-15 ใน ADR นั้น (ADR ชนะ)
- 🔴 ticket เก่า #211 (7 วัน, cashier), #212 (5 วิ, `offlineOk`), #195 (ป้ายเทา) **ยังเป็นเนื้อหาเก่า** — อย่าลงมือจนกว่าจะแก้ตามข้อ 5
- 🔴 merge commit ของ `origin/main` เข้า PR #254 (`bf175ad`) ไม่มีบรรทัด Co-Authored-By — ไม่ force-push แก้
- `/sw.js` ต้อง cert ที่ browser เชื่อ — cert self-signed ของ `mob04` ทำให้ SW ลงทะเบียนไม่ได้ (08 §4, §17)
- worktree `.claude/worktrees/agent-a63d02f13dbec7a0a` (branch `docs/phase2-spec`) ลบได้หลังอ่านไฟล์นี้

## 7. อ้างอิง
#240 (decisions) · #243 (map) · PR #254 · #237 (runner) · #241 · #242 · #245 · `08_PHASE2_SPEC.md` §2 §16 §17 §18
