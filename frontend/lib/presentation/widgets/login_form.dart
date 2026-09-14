// LoginForm — the username/password form shared by LoginDialog (Settings, on
// the Drift build) and LoginScreen (#143, the API build's signed-out route).
//
// Every string here was already in LoginDialog before #143; none is new. A
// refusal shows `Unauthenticated.errorMessage`, which AuthCubit.login builds
// from ServerErrorResolver — the form never words a server error itself.

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../blocs/auth_cubit.dart';
import 'app_button.dart';
import 'app_text_field.dart';

class LoginForm extends StatefulWidget {
  const LoginForm({super.key, this.onSuccess, this.onCancel});

  /// Called after a successful login while the form is still mounted. The
  /// login route passes nothing: its redirect leaves the route by itself.
  final VoidCallback? onSuccess;

  /// Shows a cancel button when given (the dialog); the login route has none.
  final VoidCallback? onCancel;

  @override
  State<LoginForm> createState() => _LoginFormState();
}

class _LoginFormState extends State<LoginForm> {
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _busy = false;
  String? _errorMessage;

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final username = _usernameController.text.trim();
    final password = _passwordController.text;

    if (username.isEmpty || password.isEmpty) {
      setState(() {
        _errorMessage = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน';
      });
      return;
    }

    setState(() {
      _busy = true;
      _errorMessage = null;
    });

    final cubit = context.read<AuthCubit>();
    final success = await cubit.login(username: username, password: password);

    // On the login route a success redirects away and unmounts this form.
    if (!mounted) return;

    if (success) {
      widget.onSuccess?.call();
    } else {
      final state = cubit.state;
      setState(() {
        _busy = false;
        _errorMessage = (state is Unauthenticated)
            ? state.errorMessage ?? 'เข้าสู่ระบบไม่สำเร็จ'
            : 'เข้าสู่ระบบไม่สำเร็จ';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = context.watch<AuthCubit>().state;
    final isPosDevice = authState is Authenticated
        ? authState.isPos
        : (authState is Unauthenticated ? authState.isPos : false);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: isPosDevice
                ? AppColors.success.withValues(alpha: 0.1)
                : Colors.grey.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(6),
            border: Border.all(
              color: isPosDevice
                  ? AppColors.success.withValues(alpha: 0.3)
                  : Colors.grey.withValues(alpha: 0.3),
            ),
          ),
          child: Row(
            children: [
              Icon(
                isPosDevice ? Icons.point_of_sale : Icons.computer,
                size: 18,
                color: isPosDevice ? AppColors.success : Colors.grey[700],
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  isPosDevice
                      ? 'เครื่อง POS (มีสิทธิ์ขายและบันทึกเงินสด)'
                      : 'โหมด Backoffice (ยังไม่ได้ผูกเครื่อง POS)',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: isPosDevice ? AppColors.success : Colors.grey[800],
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        AppTextField(
          label: 'ชื่อผู้ใช้ (Username)',
          hint: 'กรอกชื่อผู้ใช้',
          controller: _usernameController,
          autofocus: true,
          enabled: !_busy,
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 12),
        AppTextField(
          label: 'รหัสผ่าน (Password)',
          hint: 'กรอกรหัสผ่าน',
          controller: _passwordController,
          obscureText: true,
          enabled: !_busy,
          errorText: _errorMessage,
          textInputAction: TextInputAction.done,
          onSubmitted: _submit,
        ),
        const SizedBox(height: 20),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (widget.onCancel != null) ...[
              TextButton(
                onPressed: _busy ? null : widget.onCancel,
                child: const Text('ยกเลิก'),
              ),
              const SizedBox(width: 8),
            ],
            AppButton(
              label: 'เข้าสู่ระบบ',
              onPressed: _busy ? null : _submit,
              busy: _busy,
            ),
          ],
        ),
      ],
    );
  }
}
