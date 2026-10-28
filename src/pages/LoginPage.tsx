import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Paper,
  Alert,
  InputAdornment,
  CircularProgress,
  Tabs, Tab,
} from '@mui/material';
import PhoneIcon from '@mui/icons-material/Phone';
import LockIcon from '@mui/icons-material/Lock';
import { useAuthStore } from '../stores/useAuthStore';
import { useLocation, useNavigate } from 'react-router-dom';
import { getLastCloudPhone } from '../services/authSession';
import { getSmsCaptchaToken } from '../services/captcha';

type LoginLocationState = {
  from?: string | { pathname?: string; search?: string; hash?: string } | null;
  reason?: string;
} | null;

function resolveLoginRedirect(state: LoginLocationState) {
  const from = state?.from;
  if (typeof from === 'string') return from.startsWith('/login') ? '/' : from;
  const pathname = from?.pathname || '/';
  if (pathname.startsWith('/login')) return '/';
  return `${pathname}${from?.search || ''}${from?.hash || ''}`;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, loginWithPassword, sendCode, enterLocalMode, logout, isLoggedIn, isLoading, token, authMode, user } = useAuthStore();
  const [loginMethod, setLoginMethod] = useState<'code' | 'password'>(() => (localStorage.getItem('pneumata-login-method') as 'code' | 'password') || 'code');
  const [password, setPassword] = useState('');

  const [phone, setPhone] = useState(() => getLastCloudPhone());
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [mockCode, setMockCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [loginAttempted, setLoginAttempted] = useState(false);
  const locationState = location.state as LoginLocationState;
  const loginReason = locationState?.reason;
  const redirectTarget = resolveLoginRedirect(locationState);

  const dismissLoginReason = useCallback(() => {
    if (!loginReason) return;
    // Keep the intended redirect target, but do not let a stale session reason
    // mask errors from the new login attempt.
    navigate(location.pathname, {
      replace: true,
      state: locationState?.from ? { from: locationState.from } : null,
    });
  }, [loginReason, location.pathname, locationState?.from, navigate]);

  const getLoginErrorMessage = useCallback((err: unknown, fallback: string) => {
    if (err instanceof TypeError && /fetch|network|failed/i.test(err.message)) {
      return '无法连接服务器，请检查后端服务或网络连接后重试';
    }
    if (err instanceof Error && err.message.trim()) return err.message;
    return fallback;
  }, []);

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((c) => c - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const handleSendCode = useCallback(async () => {
    setLoginAttempted(true);
    dismissLoginReason();
    if (!phone || phone.length < 5) {
      setError('请输入有效的手机号');
      return;
    }

    setSendingCode(true);
    setError('');
    try {
      const captchaToken = await getSmsCaptchaToken({ phone, purpose: 'login' });
      const result = await sendCode(phone, 'login', captchaToken);
      setCodeSent(true);
      setCountdown(60);
      if (result.mock && result.code) {
        setMockCode(result.code);
        setCode(result.code); // Auto-fill in dev mode
      }
    } catch (err) {
      setError(getLoginErrorMessage(err, '发送验证码失败'));
    } finally {
      setSendingCode(false);
    }
  }, [dismissLoginReason, getLoginErrorMessage, phone, sendCode]);

  const handleLogin = useCallback(async () => {
    setLoginAttempted(true);
    dismissLoginReason();
    if (!phone || (loginMethod === 'code' ? !code : !password)) {
      setError(loginMethod === 'code' ? '请输入手机号和验证码' : '请输入手机号和密码');
      return;
    }

    setError('');
    try {
      localStorage.setItem('pneumata-login-method', loginMethod);
      if (loginMethod === 'code') await login(phone, code); else await loginWithPassword(phone, password);
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      setError(getLoginErrorMessage(err, '登录失败'));
    }
  }, [dismissLoginReason, getLoginErrorMessage, phone, code, password, loginMethod, login, loginWithPassword, navigate, redirectTarget]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (!codeSent) {
          handleSendCode();
        } else {
          handleLogin();
        }
      }
    },
    [codeSent, handleSendCode, handleLogin]
  );

  if (isLoggedIn || (authMode === 'cloud' && Boolean(token))) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: (theme) => theme.palette.mode === 'dark' ? '#0A0A0F' : '#F5F5F7', p: 2 }}>
        <Paper elevation={0} sx={{ width: '100%', maxWidth: 420, p: 3, borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" sx={{ mb: 1 }}>当前已登录</Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            {user?.phone ? `账号：${user.phone}` : '当前会话仍然有效'}
          </Typography>
          <Button fullWidth variant="contained" onClick={() => navigate(redirectTarget, { replace: true })} sx={{ mb: 1 }}>
            返回应用
          </Button>
          <Button fullWidth variant="outlined" disabled={isLoading} onClick={() => void logout()}>
            退出并切换账号
          </Button>
        </Paper>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: (theme) => theme.palette.mode === 'dark' ? '#0A0A0F' : '#F5F5F7',
        p: 2,
      }}
    >
      <Paper
        elevation={8}
        sx={{
          p: 4,
          width: '100%',
          maxWidth: 400,
          borderRadius: 3,
        }}
      >
        <Box sx={{ textAlign: 'center', mb: 4 }}>
          <Typography variant="h3" sx={{ mb: 1 }}>
            🍵
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 'bold' }}>Sense Murmur</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            AI 群聊模拟平台
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            可跳过登录离线使用；登录后再同步到云端
          </Typography>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {loginReason === 'expired' && !error && !loginAttempted ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            登录已过期，请重新登录。
          </Alert>
        ) : null}

        {mockCode && (
          <Alert severity="info" sx={{ mb: 2 }}>
            开发模式 - 验证码：{mockCode}
          </Alert>
        )}

        <Tabs value={loginMethod} onChange={(_, value) => { setLoginMethod(value); setError(''); localStorage.setItem('pneumata-login-method', value); }} variant="fullWidth" sx={{ mb: 2 }}>
          <Tab value="code" label="验证码登录" />
          <Tab value="password" label="密码登录" />
        </Tabs>

        <TextField
          fullWidth
          label="手机号"
          placeholder="请输入手机号"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={handleKeyDown}
          sx={{ mb: 2 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <PhoneIcon />
                </InputAdornment>
              ),
            },
          }}
        />

        {loginMethod === 'code' && codeSent && (
          <TextField
            fullWidth
            label="验证码"
            placeholder="请输入验证码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={handleKeyDown}
            sx={{ mb: 2 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <LockIcon />
                  </InputAdornment>
                ),
              },
            }}
          />
        )}

        {loginMethod === 'password' ? (
          <TextField fullWidth label="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={handleKeyDown} sx={{ mb: 2 }} />
        ) : null}

        {loginMethod === 'password' ? (
          <Button fullWidth variant="contained" size="large" onClick={handleLogin} disabled={isLoading || !phone || !password} sx={{ py: 1.5, borderRadius: 2 }}>{isLoading ? <CircularProgress size={24} /> : '登录'}</Button>
        ) : !codeSent ? (
          <>
            <Button
              fullWidth
              variant="contained"
              size="large"
              onClick={handleSendCode}
              disabled={sendingCode || !phone}
              sx={{ py: 1.5, borderRadius: 2 }}
            >
              {sendingCode ? <CircularProgress size={24} /> : '获取验证码'}
            </Button>
            <Button
              fullWidth
              variant="text"
              onClick={() => {
                enterLocalMode();
                navigate('/', { replace: true });
              }}
              sx={{ mt: 1.5 }}
            >
              跳过登录，离线使用
            </Button>
          </>
        ) : (
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="outlined"
              onClick={handleSendCode}
              disabled={countdown > 0 || sendingCode}
              sx={{ minWidth: 120, borderRadius: 2 }}
            >
              {countdown > 0 ? `${countdown}s` : '重新发送'}
            </Button>
            <Button
              fullWidth
              variant="contained"
              size="large"
              onClick={handleLogin}
              disabled={isLoading || !code}
              sx={{ py: 1.5, borderRadius: 2 }}
            >
              {isLoading ? <CircularProgress size={24} /> : '登录'}
            </Button>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
