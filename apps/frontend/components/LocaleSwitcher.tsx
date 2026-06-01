'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Tooltip,
} from '@mui/material';
import TranslateOutlinedIcon from '@mui/icons-material/TranslateOutlined';
import CheckOutlinedIcon from '@mui/icons-material/CheckOutlined';
import { setLocale } from '@/app/actions/set-locale';

type LocaleOption = {
  code: 'en' | 'ar' | 'ne';
  label: string;
};

const LOCALES: LocaleOption[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
  { code: 'ne', label: 'नेपाली' },
];

export default function LocaleSwitcher() {
  const router = useRouter();
  const current = useLocale();
  const t = useTranslations('settings');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [, startTransition] = useTransition();

  const tooltip = (() => {
    try {
      return t('changeLanguage');
    } catch {
      return 'Change language';
    }
  })();

  const handleSelect = (code: LocaleOption['code']) => {
    setAnchor(null);
    if (code === current) return;
    startTransition(async () => {
      await setLocale(code);
      router.refresh();
    });
  };

  return (
    <>
      <Tooltip title={tooltip}>
        <IconButton
          aria-label="Change language"
          onClick={(e) => setAnchor(e.currentTarget)}
          size="medium"
        >
          <TranslateOutlinedIcon />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {LOCALES.map((opt) => (
          <MenuItem
            key={opt.code}
            selected={opt.code === current}
            onClick={() => handleSelect(opt.code)}
          >
            <ListItemIcon>
              {opt.code === current ? <CheckOutlinedIcon fontSize="small" /> : null}
            </ListItemIcon>
            {opt.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
