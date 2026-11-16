import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗现在只保留通用设置；API Key 由部署环境注入。 */
export type SettingsSection = 'general'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** API Key 由环境变量提供，不再把用户引导到设置中输入。 */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('general')
  return false
}
