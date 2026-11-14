'use strict';

const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Sub2API ExportData returns an accounts bundle (optionally inside the API data
// envelope). This single-profile importer requires one explicitly chosen account.
function subscriptionAccount(raw) {
  let value = raw;
  if (object(value.data) && Object.hasOwn(value.data, 'accounts')) value = value.data;
  if (Object.hasOwn(value, 'accounts')) {
    if (!Array.isArray(value.accounts) || value.accounts.length !== 1) {
      throw new Error('请仅导入一个 Sub2API 账号；多账号导出请先选择目标账号');
    }
    if (value.type && !['sub2api-data', 'sub2api-bundle'].includes(value.type)) throw new Error('Sub2API 导出类型有误');
    if (value.version != null && value.version !== 0 && value.version !== 1) throw new Error('Sub2API 导出版本有误');
    value = value.accounts[0];
  } else if (object(value.account) && Object.hasOwn(value.account, 'credentials')) {
    value = value.account;
  }
  if (!object(value)) throw new Error('订阅凭据应为对象或 token');
  // An OpenAI OAuth export is structurally similar, but belongs to a different
  // provider and must never be routed to api.anthropic.com.
  if (value.platform != null && text(value.platform).toLowerCase() !== 'anthropic') throw new Error('请选择 Anthropic / Claude 订阅账号');
  if (value.platform != null && value.type != null && !['oauth', 'setup-token'].includes(text(value.type).toLowerCase())) throw new Error('请选择 OAuth 或 setup-token 订阅账号');
  return value;
}

/** Accept setup-token, Claude OAuth credentials, or one Sub2API account export. */
function parseSubscription({ input, name, model } = {}) {
  let raw = input;
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!value || value.length > 1024 * 1024) throw new Error('请输入订阅 token 或凭据 JSON（最大 1 MB）');
    if (value.startsWith('{') || value.startsWith('[')) {
      try { raw = JSON.parse(value); } catch { throw new Error('订阅凭据 JSON 格式有误'); }
    } else {
      if (/^otpauth:\/\//i.test(value) || /^[^\s@]+@[^\s@]+(?:----|,)/.test(value)) throw new Error('2FA 登录资料需先完成登录并导出 OAuth 凭据');
      raw = { accessToken: value };
    }
  }
  if (!object(raw)) throw new Error('订阅凭据应为对象或 token');
  raw = subscriptionAccount(raw);
  const grant = raw.claudeAiOauth ?? raw.credentials ?? raw;
  if (!object(grant)) throw new Error('订阅 OAuth 凭据格式有误');
  if (['password', 'mfa_secret', 'totp_secret'].some(key => Object.hasOwn(grant, key) || Object.hasOwn(raw, key))) throw new Error('2FA 登录资料需先完成登录并导出 OAuth 凭据');
  const accessToken = text(grant.accessToken || grant.access_token);
  if (!accessToken || /\s/.test(accessToken)) throw new Error('订阅凭据缺少有效的 accessToken');
  const refreshToken = text(grant.refreshToken || grant.refresh_token);
  if (/\s/.test(refreshToken)) throw new Error('订阅凭据 refreshToken 格式有误');
  const scopes = Array.isArray(grant.scopes) ? grant.scopes.filter(scope => typeof scope === 'string') : text(grant.scope).split(/\s+/).filter(Boolean);
  let expiresAt = grant.expiresAt ?? grant.expires_at;
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt === 'string' && !/^\d+(\.\d+)?$/.test(expiresAt)) expiresAt = Date.parse(expiresAt);
    expiresAt = Number(expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error('订阅凭据 expiresAt 格式有误');
    if (expiresAt < 1e12) expiresAt *= 1000;
    if (expiresAt <= Date.now() && !refreshToken) throw new Error('订阅 token 已过期，请导入新凭据');
  }
  const selectedModel = text(model) || text(raw.model) || 'claude-sonnet-4-6';
  const label = text(name) || text(raw.name) || 'Claude 订阅';
  return {
    name: label,
    tokens: { accessToken, ...(refreshToken ? { refreshToken } : {}), ...(expiresAt ? { expiresAt } : {}),
      scopes, ...(raw.account ? { account: raw.account } : {}) },
    config: {
      inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://api.anthropic.com',
      inferenceGatewayAuthScheme: 'bearer', credentials: { accessToken, ...(refreshToken ? { refreshToken } : {}), ...(expiresAt ? { expiresAt } : {}) },
      inferenceModels: [{ id: selectedModel }], deploymentDisplayName: label,
    },
  };
}

module.exports = { parseSubscription };
