/** Huawei key configuration labels belong to the settings locale. */
export const zh = {
  nav: '华为云 MaaS',
  intro: '使用自己的华为云 API Key，通过官方 ZCode 运行 GLM-5.2。',
  endpoint: 'API 地址',
  model: '模型',
  key: 'API Key',
  stored: '已保存在 Windows 凭据管理器',
  missing: '尚未配置 API Key',
  unavailable: '系统凭据存储暂不可用，无法保存或读取 Key。',
  unsupported: '此版本的系统凭据存储需要 Windows。',
  storage: 'Key 保存在此 Windows 用户的系统凭据存储中。更换电脑或用户后需要重新配置。',
  placeholder: '在本机填写 API Key',
  save: '保存 Key',
  clear: '删除 Key',
  refresh: '刷新状态',
  loading: '正在读取配置状态…',
  saved: 'Key 已保存。',
  cleared: 'Key 已删除。',
  failure: '操作未完成，请检查系统凭据存储后重试。',
  invalid: '请输入有效的 API Key。',
}

export type HuaweiMaaSLocaleKey = keyof typeof zh

export const en: Record<HuaweiMaaSLocaleKey, string> = {
  nav: 'Huawei Cloud MaaS',
  intro: 'Run GLM-5.2 through official ZCode with your Huawei Cloud API Key.',
  endpoint: 'API URL',
  model: 'Model',
  key: 'API Key',
  stored: 'Stored in Windows Credential Manager',
  missing: 'API Key not configured',
  unavailable: 'System credential storage is unavailable. The key cannot be saved or read.',
  unsupported: 'System credential storage in this version requires Windows.',
  storage:
    'The key is stored for this Windows user. Configure it again on another computer or user account.',
  placeholder: 'Enter the API Key locally',
  save: 'Save key',
  clear: 'Delete key',
  refresh: 'Refresh status',
  loading: 'Reading configuration status…',
  saved: 'Key saved.',
  cleared: 'Key deleted.',
  failure: 'The operation failed. Check system credential storage and try again.',
  invalid: 'Enter a valid API Key.',
}
