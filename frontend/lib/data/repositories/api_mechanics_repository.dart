// ApiMechanicsRepository — write-through cache implementation of MechanicsRepository.
//
// Complies with ADR-0010:
//  • Server is the authority on mechanic credit balances and payment receipts (CP###).
//  • Patches rows directly in Drift without dual-bookkeeping locally.

import '../../core/network/api_exception.dart';
import 'package:drift/drift.dart';

import '../../core/network/api_client.dart';
import 'api/api_wire.dart';
import '../db/database.dart';
import 'mechanics_repository.dart';

class ApiMechanicsRepository extends MechanicsRepository {
  final ApiClient apiClient;

  ApiMechanicsRepository(super.db, this.apiClient);

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

  /// The attempts at a settlement that never got a verdict — see [PendingWrites].
  ///
  /// 🔴 A credit payment is cash over the counter, so it takes the same two
  /// defences as a bill (#24): the `Idempotency-Key` and the client's own id,
  /// both minted once per attempt and resent verbatim. The first version of this
  /// method sent neither, so the server refused it outright — and a retry with a
  /// fresh key after a lost reply would have wiped a second instalment of debt
  /// the mechanic never paid.
  final PendingWrites _pending = PendingWrites('cp');

  @override
  Future<CreditPaymentRow> addCreditPayment({
    required String mechanicId,
    required double amount,
    String? note,
    required String paymentMethod,
    bool allowOverpayment = false,
  }) async {
    final attempt = _pending.of(
      [mechanicId, wireMoney(amount), paymentMethod, note ?? ''].join('|'),
    );
    final body = <String, dynamic>{
      'id': attempt.id,
      'amount': wireMoney(amount),
      'paymentMethod': paymentMethod,
      'note': ?note,
      // Only ever true when a human confirmed the overpayment dialog — the
      // screen decides, this layer carries it (consent is never inferred, #56).
      if (allowOverpayment) 'allowOverpayment': true,
    };

    // An ApiException means the server answered: a 4xx closes the attempt, a 5xx
    // leaves it parked so the next press replays it — and neither may fall
    // through to Drift (the contract test checks the guard's exact shape).
    final Object? res;
    try {
      res = await apiClient.post(
        '/api/v1/mechanics/$mechanicId/credit-payments',
        body: body,
        headers: attempt.headers,
      );
    } on ApiException catch (e) {
      rethrowServerRefusal(_settle(attempt, e));
    } catch (_) {
      // Transport failure: phase 1 keeps the shop working on Drift (#55). The
      // local write completes the action from the counter's point of view, so the
      // attempt is closed — a later identical payment is a new one.
      _pending.close(attempt);
      return super.addCreditPayment(
        mechanicId: mechanicId,
        amount: amount,
        note: note,
        paymentMethod: paymentMethod,
      );
    }

    // Outside the try on purpose. A parse or patch error here happens AFTER the
    // server committed; letting it reach the offline fallback — as the first
    // version did via a `num` cast on the string wire format — writes the payment
    // a second time locally. It stays parked instead, so a retry replays.
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
      )..where((t) => t.id.equals(mechanicId))).write(
        MechanicsCompanion(
          creditBalance: keepMoney(
            moneyOrNull(data['mechanicCreditBalanceAfter']),
          ),
          updatedAt: Value(DateTime.now()),
        ),
      );
    });
    _pending.close(attempt);
    return row;
  }

  /// Closes [attempt] when [e] is a verdict and hands [e] back to be rethrown.
  ApiException _settle(PendingWrite attempt, ApiException e) {
    _pending.closeIfVerdict(attempt, e);
    return e;
  }
}
