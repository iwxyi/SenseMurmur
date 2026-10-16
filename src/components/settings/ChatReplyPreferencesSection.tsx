import { useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { MAX_CHAT_REPLY_PREFERENCE_LENGTH, resolveChatReplyPreferenceText } from '../../types/chatReplyPreferences';

export default function ChatReplyPreferencesSection() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const preferences = useSettingsStore((state) => state.chatReplyPreferences);
  const setPreferences = useSettingsStore((state) => state.setChatReplyPreferences);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const handleOpen = () => {
    setDraft(resolveChatReplyPreferenceText(preferences));
    setOpen(true);
  };

  const handleSave = () => {
    setPreferences({ mode: 'custom', text: draft });
    setOpen(false);
  };

  return (
    <>
      <Button variant="outlined" startIcon={<EditIcon />} onClick={handleOpen}>
        {zh ? '聊天偏好' : 'Chat preferences'}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{zh ? '聊天偏好' : 'Chat preferences'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth multiline minRows={8} maxRows={16}
            label={zh ? '希望 AI 如何回复' : 'How AI should respond'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            slotProps={{ htmlInput: { maxLength: MAX_CHAT_REPLY_PREFERENCE_LENGTH } }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</Button>
          <Button variant="contained" onClick={handleSave}>{zh ? '保存' : 'Save'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
