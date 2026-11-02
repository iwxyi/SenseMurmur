import VipLimitDialog from './VipLimitDialog';
import { useMultimediaPermissionDialog } from '../../services/multimediaPermission';

export default function MultimediaPermissionDialog() {
  const { message, close } = useMultimediaPermissionDialog();
  return <VipLimitDialog open={Boolean(message)} title="多媒体生成权限" description={message || ''} onClose={close} />;
}
