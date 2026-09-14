// ApiMechanicsRepository — write-through cache implementation of MechanicsRepository.
//
// Complies with ADR-0010:
//  • Server is the authority on mechanic credit balances and payment receipts (CP###).
//  • Patches rows directly in Drift without dual-bookkeeping locally.

import '../../core/network/api_exception.dart';
import 'package:drift/drift.dart';

import '../../core/network/api_client.dart';
import '../../core/utils/ids.dart';
import 'api/api_wire.dart';
import '../db/database.dart';
import 'mechanics_repository.dart';

class ApiMechanicsRepository extends MechanicsRepository {
  final ApiClient apiClient;

  ApiMechanicsRepository(
    super.db,
    this.apiClient, {
    this.writesToServer = true,
  });

  /// Whether a credit payment is a server write — the `USE_API_WRITES` switch
  /// (`useApi`), the same one that moves sales, returns and shifts.
  ///
  /// 🔴 This class is ALSO the Drift build's mechanics repository: #55's read
  /// switch (`useApiRepositories`) defaults to true. With this false the payment
  /// is the Drift write it always was — local CP number, local balance cut, no
  /// outbox, no shift check. Without the switch, #24's outbox queued every payment
  /// on the shop's serverless build forever: the dialog said "saved", the debt
  /// never moved.
  ///
  /// When true: the outbox, and no payment without an open drawer (owner,
  /// 2026-09-13).
  final bool writesToServer;

  MechanicsCompanion _mechanicToCompanion(Map<String, dynamic> json) {
    final id = json['id'] as String;
    final code = (json['code'] ?? '') as String;
    final name = (json['name'] ?? '') as String;
    final nameTH = (json['nameTH'] ?? json['name_t_h']) as String?;
    final nickname = json['nickname'] as String?;
    final shopName = (json['shopName'] ?? json['shop_name']) as String?;
    final phone = json['phone'] as String?;
    final note = json['note'] as String?;

    double parseNum(dynamic val) {
      if (val is num) return val.toDouble();
      if (val is String) return double.tryParse(val) ?? 0.0;
      return 0.0;
    }

    final creditLimit = parseNum(json['creditLimit'] ?? json['credit_limit']);
    final creditBalance = parseNum(json['creditBalance'] ?? json['credit_balance']);
    final totalSales = parseNum(json['totalSales'] ?? json['total_sales']);
    final totalCredit = parseNum(json['totalCredit'] ?? json['total_credit']);
    final totalDiscount = parseNum(json['totalDiscount'] ?? json['total_discount']);
    final totalMarkup = parseNum(json['totalMarkup'] ?? json['total_markup']);
    final createdAt = (json['createdAt'] ?? json['created_at'] ?? '') as String;

    DateTime? updatedAt;
    if (json['updatedAt'] != null) {
      updatedAt = DateTime.tryParse(json['updatedAt'].toString());
    }
    DateTime? deletedAt;
    if (json['deletedAt'] != null) {
      deletedAt = DateTime.tryParse(json['deletedAt'].toString());
    }

    return MechanicsCompanion(
      id: Value(id),
      code: Value(code),
      name: Value(name),
      nameTH: Value(nameTH),
      nickname: Value(nickname),
      shopName: Value(shopName),
      phone: Value(phone),
      note: Value(note),
      creditLimit: Value(creditLimit),
      creditBalance: Value(creditBalance),
      totalSales: Value(totalSales),
      totalCredit: Value(totalCredit),
      totalDiscount: Value(totalDiscount),
      totalMarkup: Value(totalMarkup),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
      deletedAt: Value(deletedAt),
    );
  }

  Future<void> syncFromServer() async {
    try {
      final res = await apiClient.get('/api/v1/mechanics');
      if (res is List) {
        await db.batch((batch) {
          for (final item in res) {
            if (item is Map) {
              final comp = _mechanicToCompanion(Map<String, dynamic>.from(item));
              batch.insert(
                db.mechanics,
                comp,
                onConflict: DoUpdate((old) => comp),
              );
            }
          }
        });
      }
    } catch (_) {}
  }

  @override
  Future<List<MechanicRow>> getMechanics() async {
    // Queued payments first, so the balances this read brings back include them.
    await flushPendingCreditPayments();
    await syncFromServer();
    return (db.select(db.mechanics)..where((t) => t.deletedAt.isNull())).get();
  }

  @override
  Future<MechanicRow> addMechanic(MechanicsCompanion data) async {
    try {
      final body = {
        'name': data.name.present ? data.name.value : '',
        if (data.nameTH.present && data.nameTH.value != null) 'nameTH': data.nameTH.value,
        if (data.nickname.present && data.nickname.value != null) 'nickname': data.nickname.value,
        if (data.shopName.present && data.shopName.value != null) 'shopName': data.shopName.value,
        if (data.phone.present && data.phone.value != null) 'phone': data.phone.value,
        if (data.note.present && data.note.value != null) 'note': data.note.value,
        if (data.creditLimit.present) 'creditLimit': data.creditLimit.value.toStringAsFixed(2),
      };

      final res = await apiClient.post('/api/v1/mechanics', body: body);
      if (res is Map) {
        final comp = _mechanicToCompanion(Map<String, dynamic>.from(res));
        await db.into(db.mechanics).insertOnConflictUpdate(comp);
        return (db.select(db.mechanics)..where((t) => t.id.equals(comp.id.value))).getSingle();
      }
    } on ApiException catch (e) {
      rethrowServerRefusal(e);
    } catch (_) {
      // Offline fallback
    }

    return super.addMechanic(data);
  }

  @override
  Future<void> updateMechanic(String id, MechanicsCompanion patch) async {
    try {
      final body = <String, dynamic>{};
      if (patch.name.present) body['name'] = patch.name.value;
      if (patch.nameTH.present) body['nameTH'] = patch.nameTH.value;
      if (patch.nickname.present) body['nickname'] = patch.nickname.value;
      if (patch.shopName.present) body['shopName'] = patch.shopName.value;
      if (patch.phone.present) body['phone'] = patch.phone.value;
      if (patch.note.present) body['note'] = patch.note.value;
      if (patch.creditLimit.present) body['creditLimit'] = patch.creditLimit.value.toStringAsFixed(2);

      final res = await apiClient.patch('/api/v1/mechanics/$id', body: body);
      if (res is Map) {
        final comp = _mechanicToCompanion(Map<String, dynamic>.from(res));
        await db.into(db.mechanics).insertOnConflictUpdate(comp);
        return;
      }
    } on ApiException catch (e) {
      rethrowServerRefusal(e);
    } catch (_) {}

    await super.updateMechanic(id, patch);
  }

  @override
  Future<void> deleteMechanic(String id) async {
    try {
      await apiClient.delete('/api/v1/mechanics/$id');
    } catch (_) {}

    await (db.update(db.mechanics)..where((t) => t.id.equals(id))).write(
      MechanicsCompanion(
        deletedAt: Value(DateTime.now()),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  // ── Credit payments (#24): an outbox in Drift ───────────────────────────────
  //
  // 🔴 A credit payment is cash over the counter. Every one is written to
  // `pending_credit_payments` — with its client id and `Idempotency-Key` — BEFORE
  // the request goes out, and leaves that table only when the server has answered
  // for it. So:
  //  • a lost reply, a 5xx or no network at all leaves it queued, and every resend
  //    carries the SAME id, key and body, however much later and across however
  //    many restarts (the key alone expires after 24h; the id never does);
  //  • nothing is written to `credit_payments` or the balance from this device's
  //    own numbers — no local CP number, no second bookkeeping (ADR-0010). The
  //    old Drift fallback did both, and the next `syncFromServer` then put the
  //    whole debt back while the cash sat in the drawer.

  /// Ids being sent right now, so a flush never races the dialog's own send.
  final Set<String> _sending = {};
  Future<void>? _flushing;

  @override
  Future<CreditPaymentRow> addCreditPayment({
    required String mechanicId,
    required double amount,
    String? note,
    required String paymentMethod,
    bool allowOverpayment = false,
  }) async {
    if (!writesToServer) {
      return super.addCreditPayment(
        mechanicId: mechanicId,
        amount: amount,
        note: note,
        paymentMethod: paymentMethod,
        allowOverpayment: allowOverpayment,
      );
    }
    // 🔴 BEFORE the outbox row. Offline, the server's `409 NO_OPEN_SHIFT` would
    // only come back during a later flush — with the cash already in the drawer
    // and nobody at the dialog. So the cached drawer is asked here instead.
    if (!await hasOpenShift(db)) {
      throw const PosException('NO_OPEN_SHIFT', noOpenShiftForCreditPayment);
    }
    final id = newId('cp');
    _sending.add(id);
    try {
      await db
          .into(db.pendingCreditPayments)
          .insert(
            PendingCreditPaymentsCompanion.insert(
              id: id,
              idempotencyKey: newId('idem'),
              mechanicId: mechanicId,
              amount: wireMoney(amount),
              paymentMethod: paymentMethod,
              note: Value(note),
              // Only ever true when a human confirmed the overpayment dialog —
              // the screen decides, this layer carries it (#56).
              allowOverpayment: Value(allowOverpayment),
              createdAt: DateTime.now(),
            ),
          );
      final pending = await (db.select(
        db.pendingCreditPayments,
      )..where((t) => t.id.equals(id))).getSingle();

      try {
        return await _send(pending);
      } on ApiException catch (e) {
        if (!_isVerdict(e)) throw const CreditPaymentQueued();
        // The server refused THIS press, with the counter still looking at the
        // dialog: nothing was stored, so it is dropped and the refusal shown.
        await (db.delete(
          db.pendingCreditPayments,
        )..where((t) => t.id.equals(id))).go();
        if (e.code == 'NO_OPEN_SHIFT') {
          throw PosException(e.code, noOpenShiftForCreditPayment, e.details);
        }
        rethrowServerRefusal(e);
      } catch (_) {
        // A dropped socket, a timeout, a reply that would not parse: the payment
        // may or may not be committed, so it stays queued with its id and key.
        throw const CreditPaymentQueued();
      }
    } finally {
      _sending.remove(id);
    }
  }

  @override
  Future<void> flushPendingCreditPayments() async {
    if (!writesToServer) return;
    await (_flushing ??= _drain().whenComplete(() => _flushing = null));
  }

  Future<void> _drain() async {
    final queued =
        await (db.select(db.pendingCreditPayments)
              ..where((t) => t.rejectedCode.isNull())
              ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
            .get();
    for (final p in queued) {
      if (!_sending.add(p.id)) continue;
      try {
        await _send(p);
      } on ApiException catch (e) {
        // Still no verdict (5xx, 429, 401): stop, and keep the order for next time.
        if (!_isVerdict(e)) return;
        // A refusal nobody is watching: the cash is taken, so the row is kept for
        // a person to settle — never retried, never silently dropped.
        await (db.update(
          db.pendingCreditPayments,
        )..where((t) => t.id.equals(p.id))).write(
          PendingCreditPaymentsCompanion(
            rejectedCode: Value(e.code),
            rejectedMessage: Value(e.thaiMessage),
          ),
        );
      } catch (_) {
        return;
      } finally {
        _sending.remove(p.id);
      }
    }
  }

  /// 401 is not an answer about the payment — only that nobody is signed in — so
  /// unlike [isVerdict] it leaves the payment queued.
  bool _isVerdict(ApiException e) => isVerdict(e) && e.statusCode != 401;

  /// One POST of [p], verbatim; on success the server's row and balance are
  /// patched in and [p] leaves the outbox, all in one transaction.
  Future<CreditPaymentRow> _send(PendingCreditPaymentRow p) async {
    final res = await apiClient.post(
      '/api/v1/mechanics/${p.mechanicId}/credit-payments',
      body: <String, dynamic>{
        'id': p.id,
        'amount': p.amount,
        'paymentMethod': p.paymentMethod,
        'note': ?p.note,
        if (p.allowOverpayment) 'allowOverpayment': true,
      },
      headers: {'Idempotency-Key': p.idempotencyKey},
    );
    final data = (res as Map).cast<String, dynamic>();
    final row = CreditPaymentRow(
      id: data['id'] as String,
      receiptNo: data['receiptNo'] as String,
      mechanicId: data['mechanicId'] as String,
      amount: money(data['amount']),
      date: stamp(data['date']),
      note: data['note'] as String?,
    );
    await db.transaction(() async {
      await db.into(db.creditPayments).insertOnConflictUpdate(row);
      await (db.update(
        db.mechanics,
      )..where((t) => t.id.equals(p.mechanicId))).write(
        MechanicsCompanion(
          creditBalance: keepMoney(
            moneyOrNull(data['mechanicCreditBalanceAfter']),
          ),
          updatedAt: Value(DateTime.now()),
        ),
      );
      await (db.delete(
        db.pendingCreditPayments,
      )..where((t) => t.id.equals(p.id))).go();
    });
    return row;
  }
}
