// Unit tests for ApiMechanicsRepository (Ticket #55 / ADR-0010).

import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:srisurart_pos/core/network/api_client.dart';
import 'package:srisurart_pos/core/network/api_exception.dart';
import 'package:srisurart_pos/data/db/database.dart';
import 'package:srisurart_pos/data/repositories/api_mechanics_repository.dart';

void main() {
  late AppDatabase db;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
  });

  tearDown(() async {
    await db.close();
  });

  test('getMechanics fetches from server, writes through to Drift, and excludes deleted', () async {
    final mockClient = MockClient((request) async {
      if (request.url.path == '/api/v1/mechanics') {
        return http.Response(
          '''{
            "status": "success",
            "data": [
              {
                "id": "m_1",
                "code": "MEC001",
                "name": "Chang Dam",
                "nameTH": "ช่างดำ",
                "nickname": "ดำ",
                "shopName": "ดำการช่าง",
                "phone": "0811111111",
                "creditLimit": "5000.00",
                "creditBalance": "1200.00",
                "totalSales": "10000.00",
                "totalDiscount": "500.00",
                "createdAt": "2026-09-12T10:00:00.000Z",
                "deletedAt": null
              },
              {
                "id": "m_del",
                "code": "MEC002",
                "name": "Deleted",
                "nameTH": "ช่างลบ",
                "creditLimit": "0.00",
                "creditBalance": "0.00",
                "createdAt": "2026-09-12T10:00:00.000Z",
                "deletedAt": "2026-09-12T11:00:00.000Z"
              }
            ]
          }''',
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }
      return http.Response('{"status":"error","error":{"code":"NOT_FOUND"}}', 404);
    });

    final apiClient = ApiClient(httpClient: mockClient);
    final repo = ApiMechanicsRepository(db, apiClient);

    final mechanics = await repo.getMechanics();

    expect(mechanics.any((m) => m.id == 'm_del'), isFalse);
    final active = mechanics.firstWhere((m) => m.id == 'm_1');
    expect(active.nameTH, 'ช่างดำ');
    expect(active.creditLimit, 5000.0);
    expect(active.creditBalance, 1200.0);

    // Verify written through to Drift
    final inDrift = await (db.select(db.mechanics)..where((t) => t.id.equals('m_1'))).getSingleOrNull();
    expect(inDrift, isNotNull);
    expect(inDrift!.nickname, 'ดำ');
  });

  group('addCreditPayment (#24)', () {
    Future<void> seedTarget() => db
        .into(db.mechanics)
        .insert(
          MechanicsCompanion.insert(
            id: 'm_target',
            code: 'MEC010',
            name: 'Target Mechanic',
            createdAt: '2026-09-12T10:00:00.000Z',
            creditBalance: const Value(2000.0),
          ),
        );

    /// Exactly what `credit-payments.service.ts` answers: money as strings.
    http.Response created(Map<String, dynamic> sent) => http.Response(
      jsonEncode({
        'status': 'success',
        'data': {
          'id': sent['id'],
          'receiptNo': 'CP07-2569-09-0001',
          'mechanicId': 'm_target',
          'amount': '500.00',
          'paymentMethod': sent['paymentMethod'],
          'note': sent['note'],
          'date': '2026-09-12T13:00:00.000Z',
          'shiftId': null,
          'mechanicCreditBalanceAfter': '1500.00',
        },
      }),
      201,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

    Future<int> localPayments() async =>
        (await db.select(db.creditPayments).get()).length;

    test(
      'sends the method, a client id and an Idempotency-Key, and patches from the string reply',
      () async {
        await seedTarget();
        late http.Request seen;
        final repo = ApiMechanicsRepository(
          db,
          ApiClient(
            httpClient: MockClient((request) async {
              seen = request;
              return created(jsonDecode(request.body) as Map<String, dynamic>);
            }),
          ),
        );

        final payment = await repo.addCreditPayment(
          mechanicId: 'm_target',
          amount: 500.0,
          note: 'โอน/QR · งวดแรก',
          paymentMethod: 'โอน/QR',
        );

        final sent = jsonDecode(seen.body) as Map<String, dynamic>;
        expect(seen.url.path, '/api/v1/mechanics/m_target/credit-payments');
        expect(sent['amount'], '500.00');
        expect(sent['paymentMethod'], 'โอน/QR');
        expect(sent['id'], startsWith('cp'));
        expect(sent.containsKey('allowOverpayment'), isFalse);
        expect(seen.headers['Idempotency-Key'], isNotEmpty);

        expect(payment.id, sent['id']);
        expect(payment.receiptNo, 'CP07-2569-09-0001');
        final mech = await (db.select(
          db.mechanics,
        )..where((t) => t.id.equals('m_target'))).getSingle();
        // The server's figure — never a local 2000 - 500.
        expect(mech.creditBalance, 1500.0);
        // One row: the string balance used to throw a cast error into the offline
        // fallback, which wrote the payment a second time.
        expect(await localPayments(), 1);
      },
    );

    test(
      'a 5xx keeps the attempt: the next press resends the same id and key',
      () async {
        await seedTarget();
        final sentIds = <String>[];
        final sentKeys = <String?>[];
        var calls = 0;
        final repo = ApiMechanicsRepository(
          db,
          ApiClient(
            httpClient: MockClient((request) async {
              final body = jsonDecode(request.body) as Map<String, dynamic>;
              sentIds.add(body['id'] as String);
              sentKeys.add(request.headers['Idempotency-Key']);
              if (++calls == 1) {
                return http.Response(
                  '{"status":"error","error":{"code":"BAD_GATEWAY","message":"x"}}',
                  502,
                );
              }
              return created(body);
            }),
          ),
        );

        Future<void> press() => repo.addCreditPayment(
          mechanicId: 'm_target',
          amount: 500.0,
          paymentMethod: 'เงินสด',
        );

        await expectLater(press(), throwsA(isA<PosException>()));
        // The server may have committed; no local write may happen on its answer.
        expect(await localPayments(), 0);
        await press();

        expect(sentIds[1], sentIds[0]);
        expect(sentKeys[1], sentKeys[0]);
        expect(await localPayments(), 1);
      },
    );

    test(
      'an overpayment refusal reaches the screen with its code and details, and writes nothing',
      () async {
        await seedTarget();
        final repo = ApiMechanicsRepository(
          db,
          ApiClient(
            httpClient: MockClient(
              (request) async => http.Response(
                jsonEncode({
                  'status': 'error',
                  'error': {
                    'code': 'CREDIT_PAYMENT_EXCEEDS_BALANCE',
                    'message': 'Payment is more than the outstanding balance.',
                    'details': {
                      'creditBalance': '300.00',
                      'amount': '500.00',
                      'overpayBy': '200.00',
                    },
                  },
                }),
                409,
                headers: {'content-type': 'application/json; charset=utf-8'},
              ),
            ),
          ),
        );

        final error = await repo
            .addCreditPayment(
              mechanicId: 'm_target',
              amount: 500.0,
              paymentMethod: 'เงินสด',
            )
            .then<PosException?>(
              (_) => null,
              onError: (Object e) => e as PosException,
            );

        expect(error!.code, 'CREDIT_PAYMENT_EXCEEDS_BALANCE');
        expect((error.details as Map)['creditBalance'], '300.00');
        expect(await localPayments(), 0);
      },
    );

    test('the confirmed resend carries allowOverpayment', () async {
      await seedTarget();
      late Map<String, dynamic> sent;
      final repo = ApiMechanicsRepository(
        db,
        ApiClient(
          httpClient: MockClient((request) async {
            sent = jsonDecode(request.body) as Map<String, dynamic>;
            return created(sent);
          }),
        ),
      );

      await repo.addCreditPayment(
        mechanicId: 'm_target',
        amount: 500.0,
        paymentMethod: 'เงินสด',
        allowOverpayment: true,
      );

      expect(sent['allowOverpayment'], isTrue);
    });

    test('with no server at all the payment is still taken on Drift', () async {
      await seedTarget();
      final repo = ApiMechanicsRepository(
        db,
        ApiClient(
          httpClient: MockClient(
            (_) async => throw http.ClientException('Offline'),
          ),
        ),
      );

      await repo.addCreditPayment(
        mechanicId: 'm_target',
        amount: 500.0,
        paymentMethod: 'เงินสด',
      );

      expect(await localPayments(), 1);
    });
  });

  test('getMechanics falls back transparently to Drift when network fails', () async {
    // Seed Drift locally
    await db.into(db.mechanics).insert(
          MechanicsCompanion.insert(
            id: 'm_offline',
            code: 'MEC099',
            name: 'Offline Mechanic',
            createdAt: '2026-09-12T10:00:00.000Z',
          ),
        );

    final errorClient = MockClient((request) async {
      throw http.ClientException('Offline');
    });

    final apiClient = ApiClient(httpClient: errorClient);
    final repo = ApiMechanicsRepository(db, apiClient);

    final list = await repo.getMechanics();
    expect(list.any((m) => m.name == 'Offline Mechanic'), isTrue);
  });

  test('deleteMechanic marks deletedAt in Drift as soft delete', () async {
    await db.into(db.mechanics).insert(
          MechanicsCompanion.insert(
            id: 'm_to_delete',
            code: 'MEC088',
            name: 'To Delete',
            createdAt: '2026-09-12T10:00:00.000Z',
          ),
        );

    final mockClient = MockClient((request) async {
      if (request.url.path == '/api/v1/mechanics/m_to_delete' && request.method == 'DELETE') {
        return http.Response('{"status":"success","data":{"success":true}}', 200);
      }
      return http.Response('{"status":"error","error":{"code":"NOT_FOUND"}}', 404);
    });

    final apiClient = ApiClient(httpClient: mockClient);
    final repo = ApiMechanicsRepository(db, apiClient);

    await repo.deleteMechanic('m_to_delete');

    final list = await repo.getMechanics();
    expect(list.any((m) => m.id == 'm_to_delete'), isFalse);

    final row = await (db.select(db.mechanics)..where((t) => t.id.equals('m_to_delete'))).getSingle();
    expect(row.deletedAt, isNotNull);
  });
}
