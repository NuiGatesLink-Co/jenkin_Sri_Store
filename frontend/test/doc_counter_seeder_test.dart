// #188 — seeding the local document-number counter from GET /doc-counters.

import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:srisurart_pos/core/network/api_client.dart';
import 'package:srisurart_pos/data/db/database.dart';
import 'package:srisurart_pos/data/services/doc_counter_seeder.dart';

http.Response _ok(Object data) => http.Response(
  jsonEncode({'status': 'success', 'data': data}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void main() {
  late AppDatabase db;
  late List<http.Request> requests;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    requests = [];
  });

  tearDown(() async {
    await db.close();
  });

  DocCounterSeeder seederReplying(
    Future<http.Response> Function(http.Request) reply,
  ) => DocCounterSeeder(
    db: db,
    apiClient: ApiClient(
      httpClient: MockClient((r) {
        requests.add(r);
        return reply(r);
      }),
    ),
  );

  Future<void> putLocal(String docType, String period, int lastNo) => db
      .into(db.docCounters)
      .insert(
        DocCountersCompanion.insert(
          deviceNo: 1,
          docType: docType,
          period: period,
          lastNo: lastNo,
        ),
      );

  Future<Map<String, int>> localCounters() async => {
    for (final r in await db.select(db.docCounters).get())
      '${r.deviceNo}/${r.docType}/${r.period}': r.lastNo,
  };

  test('local = max(local, server) per row, and the period is recorded as seeded', () async {
    await putLocal('receipt', '2569-09', 50); // local ahead: kept
    await putLocal('cn', '2569-09', 2); // server ahead: raised
    await putLocal('receipt', '2569-08', 10); // absent on server: untouched

    final seeder = seederReplying(
      (_) async => _ok({
        'deviceNo': 1,
        'period': '2569-09',
        'counters': [
          {'docType': 'receipt', 'period': '2569-09', 'lastNo': 42},
          {'docType': 'cn', 'period': '2569-09', 'lastNo': 7},
          {'docType': 'po', 'period': '2569-09', 'lastNo': 3}, // new row
        ],
      }),
    );

    expect(await seeder.seed(), isTrue);

    expect(await localCounters(), {
      '1/receipt/2569-09': 50,
      '1/cn/2569-09': 7,
      '1/receipt/2569-08': 10,
      '1/po/2569-09': 3,
    });
    final seeds = await db.select(db.docCounterSeeds).get();
    expect(seeds.map((s) => '${s.deviceNo}/${s.period}'), ['1/2569-09']);

    // The device comes from the token on the server — nothing names it here.
    expect(requests.single.method, 'GET');
    expect(requests.single.url.path, '/api/v1/doc-counters');
    expect(requests.single.url.query, isEmpty);
  });

  test('seeding twice is harmless and still never lowers', () async {
    final seeder = seederReplying(
      (_) async => _ok({
        'deviceNo': 1,
        'period': '2569-09',
        'counters': [
          {'docType': 'receipt', 'period': '2569-09', 'lastNo': 5},
        ],
      }),
    );
    expect(await seeder.seed(), isTrue);
    await (db.update(db.docCounters)).write(
      const DocCountersCompanion(lastNo: Value(9)),
    );
    expect(await seeder.seed(), isTrue);

    expect(await localCounters(), {'1/receipt/2569-09': 9});
    expect(await db.select(db.docCounterSeeds).get(), hasLength(1));
  });

  group('a failed fetch leaves local untouched and does not throw', () {
    final failures = <String, Future<http.Response> Function(http.Request)>{
      'transport failure': (_) async => throw http.ClientException('offline'),
      '5xx': (_) async => http.Response('<html>502</html>', 502),
      '403 refusal': (_) async => http.Response(
        jsonEncode({
          'status': 'error',
          'error': {'code': 'DEVICE_ROLE_FORBIDDEN', 'message': 'x'},
        }),
        403,
      ),
      'malformed counter after a valid one': (_) async => _ok({
        'deviceNo': 1,
        'period': '2569-09',
        'counters': [
          {'docType': 'receipt', 'period': '2569-09', 'lastNo': 99},
          {'docType': 'cn', 'period': '2569-09', 'lastNo': '7'},
        ],
      }),
      'missing deviceNo': (_) async => _ok({'period': '2569-09', 'counters': []}),
    };

    for (final entry in failures.entries) {
      test(entry.key, () async {
        await putLocal('receipt', '2569-09', 4);

        final ok = await seederReplying(entry.value).seed();

        expect(ok, isFalse);
        expect(await localCounters(), {'1/receipt/2569-09': 4});
        expect(await db.select(db.docCounterSeeds).get(), isEmpty);
      });
    }
  });
}
