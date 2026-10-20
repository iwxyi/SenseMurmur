import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles';
import { motion, transition } from '../styles/motion';
import type { ThemePresetId } from '../types/settings';

type ResolvedMode = 'light' | 'dark';

type ThemeScheme = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  paper: string;
  surface: string;
  dialog: string;
  text: string;
  textSecondary: string;
  divider: string;
  actionHover: string;
  selection: string;
  bodyBackground: string;
  menuShadow: string;
};

export type AppThemePreset = {
  id: ThemePresetId;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  preview: [string, string, string];
  schemes: Record<ResolvedMode, ThemeScheme>;
};

export const POPULAR_THEME_PRESET_COUNT = 6;

export const APP_THEME_PRESETS: AppThemePreset[] = [
  {
    id: 'rednote',
    nameZh: '莓果社交',
    nameEn: 'Berry Social',
    descriptionZh: '明亮红粉、奶油白和一点紫，偏社交、种草和年轻化。',
    descriptionEn: 'Bright berry red, cream white, and violet for a lively social feel.',
    preview: ['#E60033', '#FF7A90', '#8B5CF6'],
    schemes: {
      light: {
        primary: '#E60033',
        secondary: '#8B5CF6',
        accent: '#FF7A00',
        background: '#FFF5F7',
        paper: 'rgba(255,255,255,0.90)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#261318',
        textSecondary: '#73535D',
        divider: 'rgba(158, 32, 64, 0.12)',
        actionHover: 'rgba(230, 0, 51, 0.08)',
        selection: 'rgba(230, 0, 51, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FFF7F8 0%, #FFECEF 48%, #F7F0FF 100%)',
        menuShadow: '0 18px 44px rgba(158, 32, 64, 0.17)',
      },
      dark: {
        primary: '#FF6F8E',
        secondary: '#B69CFF',
        accent: '#FFB86A',
        background: '#18070D',
        paper: 'rgba(35, 14, 23, 0.86)',
        surface: '#28111B',
        dialog: '#230E17',
        text: '#FFF7F8',
        textSecondary: '#E8BEC9',
        divider: 'rgba(255, 214, 225, 0.13)',
        actionHover: 'rgba(255, 111, 142, 0.12)',
        selection: 'rgba(255, 111, 142, 0.28)',
        bodyBackground: 'linear-gradient(135deg, #13050A 0%, #2A0E19 54%, #1C1230 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.44)',
      },
    },
  },
  {
    id: 'jade',
    nameZh: '青玉日常',
    nameEn: 'Jade Daily',
    descriptionZh: '微信式青绿和干净白底，亲和、稳定、低学习成本。',
    descriptionEn: 'Familiar jade green on clean surfaces for a calm daily UI.',
    preview: ['#07C160', '#10B981', '#60A5FA'],
    schemes: {
      light: {
        primary: '#07A85A',
        secondary: '#2563EB',
        accent: '#F59E0B',
        background: '#F5FBF7',
        paper: 'rgba(255,255,255,0.90)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#102016',
        textSecondary: '#52665A',
        divider: 'rgba(16, 80, 44, 0.11)',
        actionHover: 'rgba(7, 168, 90, 0.08)',
        selection: 'rgba(7, 168, 90, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #F8FFFA 0%, #ECF9F1 52%, #F1F7FF 100%)',
        menuShadow: '0 18px 44px rgba(18, 79, 48, 0.15)',
      },
      dark: {
        primary: '#4ADE80',
        secondary: '#7DB7FF',
        accent: '#FACC15',
        background: '#07130D',
        paper: 'rgba(13, 28, 20, 0.86)',
        surface: '#12251A',
        dialog: '#0E1F16',
        text: '#F3FFF7',
        textSecondary: '#B9D5C4',
        divider: 'rgba(206, 255, 222, 0.12)',
        actionHover: 'rgba(74, 222, 128, 0.12)',
        selection: 'rgba(74, 222, 128, 0.26)',
        bodyBackground: 'linear-gradient(135deg, #050D08 0%, #0D2115 54%, #081829 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.42)',
      },
    },
  },
  {
    id: 'reader',
    nameZh: '护眼书房',
    nameEn: 'Reader Study',
    descriptionZh: '低刺激暖纸和墨绿，适合长时间阅读、写信和剧情。',
    descriptionEn: 'Low-glare warm paper and ink green for long reading sessions.',
    preview: ['#2F6B4F', '#C58B2B', '#EADCC2'],
    schemes: {
      light: {
        primary: '#2F6B4F',
        secondary: '#A86C18',
        accent: '#64748B',
        background: '#F8F1E4',
        paper: 'rgba(255, 250, 240, 0.92)',
        surface: '#FFF9EE',
        dialog: '#FFF9EE',
        text: '#242018',
        textSecondary: '#6A604F',
        divider: 'rgba(78, 60, 36, 0.13)',
        actionHover: 'rgba(47, 107, 79, 0.09)',
        selection: 'rgba(47, 107, 79, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FCF6EA 0%, #F0E5D0 52%, #EFF7EF 100%)',
        menuShadow: '0 18px 42px rgba(78, 57, 28, 0.18)',
      },
      dark: {
        primary: '#8CD6AD',
        secondary: '#D8A655',
        accent: '#94A3B8',
        background: '#15110B',
        paper: 'rgba(34, 29, 20, 0.88)',
        surface: '#272116',
        dialog: '#221D14',
        text: '#FBF1DE',
        textSecondary: '#D1C2AA',
        divider: 'rgba(251, 241, 222, 0.13)',
        actionHover: 'rgba(140, 214, 173, 0.12)',
        selection: 'rgba(140, 214, 173, 0.26)',
        bodyBackground: 'linear-gradient(135deg, #0F0B07 0%, #221B10 56%, #0F2118 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.44)',
      },
    },
  },
  {
    id: 'imperial',
    nameZh: '朱砂国潮',
    nameEn: 'Vermilion Heritage',
    descriptionZh: '朱砂红、鎏金和玉青，适合国风、仪式感和剧情房。',
    descriptionEn: 'Vermilion, antique gold, and jade for a heritage-inspired mood.',
    preview: ['#B91C1C', '#C99700', '#0F766E'],
    schemes: {
      light: {
        primary: '#B91C1C',
        secondary: '#0F766E',
        accent: '#B77900',
        background: '#FFF8F0',
        paper: 'rgba(255,255,255,0.90)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#241512',
        textSecondary: '#6B554A',
        divider: 'rgba(127, 29, 29, 0.13)',
        actionHover: 'rgba(185, 28, 28, 0.08)',
        selection: 'rgba(185, 28, 28, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FFF8F0 0%, #FFE8DA 50%, #ECF7F3 100%)',
        menuShadow: '0 18px 44px rgba(127, 29, 29, 0.17)',
      },
      dark: {
        primary: '#F87171',
        secondary: '#5EEAD4',
        accent: '#FACC15',
        background: '#140908',
        paper: 'rgba(32, 17, 14, 0.88)',
        surface: '#281712',
        dialog: '#22120F',
        text: '#FFF7EF',
        textSecondary: '#E2BDAE',
        divider: 'rgba(255, 226, 214, 0.13)',
        actionHover: 'rgba(248, 113, 113, 0.12)',
        selection: 'rgba(248, 113, 113, 0.28)',
        bodyBackground: 'linear-gradient(135deg, #100504 0%, #27100D 54%, #08211D 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.44)',
      },
    },
  },
  {
    id: 'night',
    nameZh: '极夜黑金',
    nameEn: 'Night Gold',
    descriptionZh: '暗黑底、香槟金和电光蓝，沉浸但不压文字。',
    descriptionEn: 'Dark surfaces with champagne gold and electric blue.',
    preview: ['#D6A64F', '#38BDF8', '#111827'],
    schemes: {
      light: {
        primary: '#7C5C18',
        secondary: '#0369A1',
        accent: '#334155',
        background: '#F7F5EF',
        paper: 'rgba(255,255,255,0.90)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#171717',
        textSecondary: '#5E5B54',
        divider: 'rgba(68, 54, 23, 0.13)',
        actionHover: 'rgba(124, 92, 24, 0.08)',
        selection: 'rgba(124, 92, 24, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FBFAF6 0%, #EFEADF 55%, #EFF7FB 100%)',
        menuShadow: '0 18px 44px rgba(46, 37, 19, 0.16)',
      },
      dark: {
        primary: '#E6C77A',
        secondary: '#38BDF8',
        accent: '#A78BFA',
        background: '#05070B',
        paper: 'rgba(14, 17, 24, 0.88)',
        surface: '#111723',
        dialog: '#0E121A',
        text: '#FAF7EF',
        textSecondary: '#C8C0AD',
        divider: 'rgba(230, 199, 122, 0.14)',
        actionHover: 'rgba(230, 199, 122, 0.12)',
        selection: 'rgba(230, 199, 122, 0.28)',
        bodyBackground: 'linear-gradient(135deg, #030508 0%, #0E121A 54%, #051A24 100%)',
        menuShadow: '0 20px 56px rgba(0, 0, 0, 0.52)',
      },
    },
  },
  {
    id: 'aurora',
    nameZh: '极光矩阵',
    nameEn: 'Aurora Matrix',
    descriptionZh: '清亮蓝紫配薄荷绿，适合高频聊天和创作。',
    descriptionEn: 'Clear blue-violet with mint accents for long chats and creation.',
    preview: ['#5B6CFF', '#12B8A6', '#F7C948'],
    schemes: {
      light: {
        primary: '#5B6CFF',
        secondary: '#0F766E',
        accent: '#F59E0B',
        background: '#F6F8FF',
        paper: 'rgba(255,255,255,0.88)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#111827',
        textSecondary: '#526070',
        divider: 'rgba(32, 46, 75, 0.11)',
        actionHover: 'rgba(91, 108, 255, 0.08)',
        selection: 'rgba(91, 108, 255, 0.22)',
        bodyBackground: 'linear-gradient(135deg, #F8FAFF 0%, #EEF5FF 45%, #F7FFFB 100%)',
        menuShadow: '0 18px 44px rgba(35, 48, 88, 0.16)',
      },
      dark: {
        primary: '#8EA0FF',
        secondary: '#46D6C7',
        accent: '#F8C66A',
        background: '#0B1020',
        paper: 'rgba(18, 23, 40, 0.84)',
        surface: '#151B2E',
        dialog: '#141A2B',
        text: '#F7F8FF',
        textSecondary: '#AEB9D5',
        divider: 'rgba(207, 216, 255, 0.13)',
        actionHover: 'rgba(142, 160, 255, 0.12)',
        selection: 'rgba(142, 160, 255, 0.28)',
        bodyBackground: 'linear-gradient(135deg, #070B16 0%, #10162A 52%, #071B1B 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.42)',
      },
    },
  },
  {
    id: 'mirage',
    nameZh: '镜湖蓝',
    nameEn: 'Mirage Blue',
    descriptionZh: '克制、专业、阅读友好的默认工作台。',
    descriptionEn: 'Restrained, professional, and easy to read.',
    preview: ['#315A9C', '#0F766E', '#94A3B8'],
    schemes: {
      light: {
        primary: '#315A9C',
        secondary: '#0F766E',
        accent: '#64748B',
        background: '#F5F5F7',
        paper: 'rgba(255,255,255,0.86)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#111827',
        textSecondary: '#5B6472',
        divider: 'rgba(15, 23, 42, 0.10)',
        actionHover: 'rgba(49, 90, 156, 0.08)',
        selection: 'rgba(49, 90, 156, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #F7F8FB 0%, #EEF2F7 58%, #F7FAFA 100%)',
        menuShadow: '0 18px 44px rgba(15, 23, 42, 0.16)',
      },
      dark: {
        primary: '#82A8E8',
        secondary: '#5DD6C9',
        accent: '#CBD5E1',
        background: '#0A0A0F',
        paper: 'rgba(20, 22, 30, 0.82)',
        surface: '#1F2430',
        dialog: '#14161E',
        text: '#F8FAFC',
        textSecondary: '#B8C1D0',
        divider: 'rgba(226, 232, 240, 0.12)',
        actionHover: 'rgba(130, 168, 232, 0.12)',
        selection: 'rgba(130, 168, 232, 0.26)',
        bodyBackground: 'linear-gradient(135deg, #090A10 0%, #111827 58%, #0D1E21 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.38)',
      },
    },
  },
  {
    id: 'paper',
    nameZh: '纸墨茶',
    nameEn: 'Paper Tea',
    descriptionZh: '温润纸感与墨绿，适合长文、信件和剧情阅读。',
    descriptionEn: 'Warm paper texture and ink green for long-form reading.',
    preview: ['#2E6B57', '#A16207', '#E7D8B7'],
    schemes: {
      light: {
        primary: '#2E6B57',
        secondary: '#A16207',
        accent: '#8B5CF6',
        background: '#F7F2E8',
        paper: 'rgba(255, 250, 239, 0.90)',
        surface: '#FFFBF1',
        dialog: '#FFFBF1',
        text: '#25231F',
        textSecondary: '#6B6256',
        divider: 'rgba(77, 64, 45, 0.14)',
        actionHover: 'rgba(46, 107, 87, 0.09)',
        selection: 'rgba(46, 107, 87, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FBF6EA 0%, #F1E7D3 52%, #EFF6EC 100%)',
        menuShadow: '0 18px 42px rgba(79, 57, 32, 0.18)',
      },
      dark: {
        primary: '#7BC7A9',
        secondary: '#D7A85D',
        accent: '#B69DF8',
        background: '#15120E',
        paper: 'rgba(33, 29, 23, 0.86)',
        surface: '#252019',
        dialog: '#211D17',
        text: '#F7EEDD',
        textSecondary: '#CBBDA7',
        divider: 'rgba(247, 238, 221, 0.13)',
        actionHover: 'rgba(123, 199, 169, 0.12)',
        selection: 'rgba(123, 199, 169, 0.26)',
        bodyBackground: 'linear-gradient(135deg, #100D0A 0%, #201A12 55%, #10201B 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.42)',
      },
    },
  },
  {
    id: 'sakura',
    nameZh: '樱桃电台',
    nameEn: 'Sakura Radio',
    descriptionZh: '柔粉、葡萄紫和清爽青色，社交感更强。',
    descriptionEn: 'Soft rose, grape, and cyan with a more social mood.',
    preview: ['#D9467A', '#7C3AED', '#06B6D4'],
    schemes: {
      light: {
        primary: '#D9467A',
        secondary: '#7C3AED',
        accent: '#0891B2',
        background: '#FFF5F8',
        paper: 'rgba(255,255,255,0.88)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#251821',
        textSecondary: '#705664',
        divider: 'rgba(126, 36, 76, 0.12)',
        actionHover: 'rgba(217, 70, 122, 0.09)',
        selection: 'rgba(217, 70, 122, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FFF7FA 0%, #F7F0FF 52%, #F0FDFF 100%)',
        menuShadow: '0 18px 44px rgba(126, 36, 76, 0.16)',
      },
      dark: {
        primary: '#FF8DB3',
        secondary: '#B79CFF',
        accent: '#67E8F9',
        background: '#160A13',
        paper: 'rgba(34, 19, 31, 0.84)',
        surface: '#261526',
        dialog: '#22131F',
        text: '#FFF7FA',
        textSecondary: '#E8BED0',
        divider: 'rgba(255, 211, 226, 0.13)',
        actionHover: 'rgba(255, 141, 179, 0.12)',
        selection: 'rgba(255, 141, 179, 0.26)',
        bodyBackground: 'linear-gradient(135deg, #130711 0%, #241226 54%, #082127 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.42)',
      },
    },
  },
  {
    id: 'ember',
    nameZh: '琥珀剧场',
    nameEn: 'Ember Theater',
    descriptionZh: '高对比暖色舞台，适合戏剧、游戏和沉浸房间。',
    descriptionEn: 'Warm high-contrast stage for dramatic and immersive rooms.',
    preview: ['#C2410C', '#7C2D12', '#22C55E'],
    schemes: {
      light: {
        primary: '#C2410C',
        secondary: '#7C2D12',
        accent: '#15803D',
        background: '#FFF7ED',
        paper: 'rgba(255,255,255,0.88)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#24150F',
        textSecondary: '#6F5548',
        divider: 'rgba(124, 45, 18, 0.13)',
        actionHover: 'rgba(194, 65, 12, 0.09)',
        selection: 'rgba(194, 65, 12, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FFF7ED 0%, #FFEBD5 50%, #F1F8EA 100%)',
        menuShadow: '0 18px 44px rgba(124, 45, 18, 0.18)',
      },
      dark: {
        primary: '#FB923C',
        secondary: '#FDBA74',
        accent: '#86EFAC',
        background: '#130B08',
        paper: 'rgba(32, 20, 15, 0.86)',
        surface: '#261710',
        dialog: '#21130E',
        text: '#FFF8F0',
        textSecondary: '#E5C0A7',
        divider: 'rgba(255, 228, 205, 0.13)',
        actionHover: 'rgba(251, 146, 60, 0.12)',
        selection: 'rgba(251, 146, 60, 0.28)',
        bodyBackground: 'linear-gradient(135deg, #110704 0%, #25130A 55%, #10200F 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.44)',
      },
    },
  },
  {
    id: 'graphite',
    nameZh: '石墨专业',
    nameEn: 'Graphite Pro',
    descriptionZh: '低彩度中性界面，强调数据密度和管理后台。',
    descriptionEn: 'Low-chroma neutral UI for dense data and admin work.',
    preview: ['#475569', '#0EA5E9', '#A3E635'],
    schemes: {
      light: {
        primary: '#475569',
        secondary: '#0EA5E9',
        accent: '#65A30D',
        background: '#F3F4F6',
        paper: 'rgba(255,255,255,0.90)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#111827',
        textSecondary: '#566173',
        divider: 'rgba(17, 24, 39, 0.12)',
        actionHover: 'rgba(71, 85, 105, 0.08)',
        selection: 'rgba(14, 165, 233, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #F8FAFC 0%, #ECEFF3 58%, #F5F7F0 100%)',
        menuShadow: '0 18px 44px rgba(15, 23, 42, 0.16)',
      },
      dark: {
        primary: '#CBD5E1',
        secondary: '#38BDF8',
        accent: '#BEF264',
        background: '#090B0F',
        paper: 'rgba(18, 21, 28, 0.86)',
        surface: '#171B24',
        dialog: '#141821',
        text: '#F8FAFC',
        textSecondary: '#B7C0CD',
        divider: 'rgba(226, 232, 240, 0.12)',
        actionHover: 'rgba(203, 213, 225, 0.10)',
        selection: 'rgba(56, 189, 248, 0.26)',
        bodyBackground: 'linear-gradient(135deg, #07090D 0%, #11151D 58%, #10180E 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.40)',
      },
    },
  },
  {
    id: 'dopamine',
    nameZh: '多巴胺晴日',
    nameEn: 'Dopamine Day',
    descriptionZh: '高明度糖果色，适合轻松、活跃和活动感页面。',
    descriptionEn: 'High-key candy colors for a playful, active interface.',
    preview: ['#FF4D6D', '#22C55E', '#3B82F6'],
    schemes: {
      light: {
        primary: '#E11D48',
        secondary: '#16A34A',
        accent: '#2563EB',
        background: '#FFFBFE',
        paper: 'rgba(255,255,255,0.90)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#20151B',
        textSecondary: '#695A63',
        divider: 'rgba(190, 24, 93, 0.12)',
        actionHover: 'rgba(225, 29, 72, 0.08)',
        selection: 'rgba(225, 29, 72, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #FFF7FB 0%, #F0FFF4 46%, #EFF6FF 100%)',
        menuShadow: '0 18px 44px rgba(148, 45, 86, 0.16)',
      },
      dark: {
        primary: '#FB7185',
        secondary: '#86EFAC',
        accent: '#93C5FD',
        background: '#100A11',
        paper: 'rgba(27, 18, 28, 0.86)',
        surface: '#211726',
        dialog: '#1D1421',
        text: '#FFF8FC',
        textSecondary: '#DFC5D4',
        divider: 'rgba(255, 216, 232, 0.13)',
        actionHover: 'rgba(251, 113, 133, 0.12)',
        selection: 'rgba(251, 113, 133, 0.28)',
        bodyBackground: 'linear-gradient(135deg, #0C070E 0%, #211426 50%, #092118 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.44)',
      },
    },
  },
  {
    id: 'morandi',
    nameZh: '莫兰迪柔雾',
    nameEn: 'Morandi Mist',
    descriptionZh: '低饱和灰粉、雾蓝和鼠尾草绿，安静耐看。',
    descriptionEn: 'Muted rose, mist blue, and sage for a soft durable look.',
    preview: ['#A67873', '#7895A8', '#8FA382'],
    schemes: {
      light: {
        primary: '#9C6F6B',
        secondary: '#66879A',
        accent: '#7D916F',
        background: '#F7F4F1',
        paper: 'rgba(255,255,255,0.88)',
        surface: '#FFFFFF',
        dialog: '#FFFFFF',
        text: '#252220',
        textSecondary: '#67615C',
        divider: 'rgba(85, 70, 64, 0.12)',
        actionHover: 'rgba(156, 111, 107, 0.08)',
        selection: 'rgba(156, 111, 107, 0.20)',
        bodyBackground: 'linear-gradient(135deg, #F8F5F2 0%, #F1ECE8 50%, #EEF4F1 100%)',
        menuShadow: '0 18px 42px rgba(82, 65, 58, 0.15)',
      },
      dark: {
        primary: '#D3A39E',
        secondary: '#9DB9C8',
        accent: '#B6CAA9',
        background: '#12100F',
        paper: 'rgba(27, 24, 23, 0.88)',
        surface: '#211D1C',
        dialog: '#1D1A19',
        text: '#F8F1EC',
        textSecondary: '#D1C3BB',
        divider: 'rgba(248, 241, 236, 0.12)',
        actionHover: 'rgba(211, 163, 158, 0.12)',
        selection: 'rgba(211, 163, 158, 0.26)',
        bodyBackground: 'linear-gradient(135deg, #0E0B0B 0%, #211B1A 52%, #17201B 100%)',
        menuShadow: '0 20px 52px rgba(0, 0, 0, 0.42)',
      },
    },
  },
];

const LEGACY_COLOR_TO_PRESET: Record<string, ThemePresetId> = {
  '#315a9c': 'mirage',
  '#0f766e': 'paper',
  '#7c3aed': 'sakura',
  '#b45309': 'ember',
  '#334155': 'graphite',
  '#5b6cff': 'aurora',
};

export function resolveThemePreset(presetId?: string | null, primaryColor?: string | null) {
  const byId = APP_THEME_PRESETS.find((preset) => preset.id === presetId);
  if (byId) return byId;
  const legacyPresetId = primaryColor ? LEGACY_COLOR_TO_PRESET[primaryColor.toLowerCase()] : null;
  return APP_THEME_PRESETS.find((preset) => preset.id === legacyPresetId) || APP_THEME_PRESETS[0];
}

const resolveScheme = (mode: ResolvedMode, presetId?: string | null, primaryColor?: string | null) => {
  const preset = resolveThemePreset(presetId, primaryColor);
  return {
    preset,
    scheme: preset.schemes[mode],
  };
};

const baseTheme: ThemeOptions = {
  typography: {
    fontFamily: [
      '"Source Han Sans SC"',
      '"Noto Sans SC"',
      '"PingFang SC"',
      '"Microsoft YaHei"',
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      '"Helvetica Neue"',
      'Arial',
      'sans-serif',
    ].join(','),
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          borderRadius: 8,
          fontWeight: 500,
          boxShadow: 'none',
          transition: transition(['background-color', 'border-color', 'box-shadow', 'color', 'transform'], motion.durations.base, motion.softOut),
          '&:active': {
            transform: 'scale(0.985)',
            transitionTimingFunction: motion.press,
            transitionDuration: `${motion.durations.instant}ms`,
          },
        },
        contained: {
          boxShadow: 'none',
        },
      },
    },
    MuiCard: {
      defaultProps: {
        elevation: 0,
      },
      styleOverrides: {
        root: {
          borderRadius: 8,
          transition: transition(['transform', 'box-shadow', 'background-color', 'border-color'], motion.durations.base, motion.softOut),
        },
      },
    },
    MuiFab: {
      styleOverrides: {
        root: {
          borderRadius: '50%',
          boxShadow: '0 6px 16px rgba(0,0,0,0.18)',
          transition: transition(['transform', 'box-shadow', 'background-color'], motion.durations.base, motion.gentleSpring),
          '&:active': {
            transform: 'scale(0.96)',
            transitionTimingFunction: motion.press,
            transitionDuration: `${motion.durations.instant}ms`,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
        },
        grouped: {
          margin: 0,
          border: 0,
          borderRadius: 999,
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          textTransform: 'none',
          paddingInline: 16,
          minHeight: 36,
          border: '1px solid',
          borderColor: 'rgba(0,0,0,0.12)',
          backgroundColor: 'transparent',
          '&.Mui-selected': {
            borderColor: 'rgba(0,0,0,0.16)',
          },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 3,
          borderRadius: 999,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          minHeight: 44,
        },
      },
    },
    MuiSnackbarContent: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiMenu: {
      defaultProps: {
        transitionDuration: { enter: 100, exit: 80 },
      },
      styleOverrides: {
        list: {
          paddingTop: 4,
          paddingBottom: 4,
        },
        paper: ({ theme }) => ({
          borderRadius: 8,
          border: '1px solid',
          borderColor: theme.palette.divider,
          backgroundColor: theme.palette.background.paper,
          backdropFilter: 'blur(22px) saturate(1.18)',
          WebkitBackdropFilter: 'blur(22px) saturate(1.18)',
          boxShadow: theme.palette.menuShadow,
        }),
      },
    },
    MuiPopover: {
      defaultProps: {
        transitionDuration: { enter: 100, exit: 80 },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          minHeight: 36,
          padding: '6px 10px',
          fontSize: '0.875rem',
          lineHeight: 1.35,
          borderRadius: 6,
          margin: '2px 4px',
          '@media (min-width: 900px)': {
            minHeight: 32,
            padding: '4px 8px',
            fontSize: '0.8125rem',
            lineHeight: 1.3,
            margin: '1px 3px',
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          transition: transition(['background-color', 'color', 'transform'], motion.durations.fast, motion.softOut),
          '&:active': {
            transform: 'scale(0.96)',
            transitionTimingFunction: motion.press,
            transitionDuration: `${motion.durations.instant}ms`,
          },
        },
      },
    },
    MuiAvatar: {
      styleOverrides: {
        root: {
          transition: transition(['transform', 'box-shadow'], motion.durations.base, motion.gentleSpring),
        },
      },
    },
    MuiCardActionArea: {
      styleOverrides: {
        root: {
          borderRadius: 'inherit',
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          opacity: 0.6,
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: (theme: Theme) => ({
        body: {
          backgroundAttachment: 'fixed',
          backgroundImage: theme.palette.backgroundImage,
        },
        '::selection': {
          background: theme.palette.selection.main,
        },
        '*': {
          scrollbarWidth: 'thin',
        },
      }),
    },
    MuiCollapse: {
      styleOverrides: {
        root: {
          transitionDuration: `${motion.durations.base}ms`,
          transitionTimingFunction: motion.softInOut,
        },
      },
    },
    MuiSlider: {
      styleOverrides: {
        root: {
          transition: transition(['transform', 'color'], motion.durations.fast, motion.softOut),
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          transition: transition(['background-color', 'color', 'transform'], motion.durations.base, motion.softOut),
        },
      },
    },
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          transition: transition(['transform', 'color', 'opacity'], motion.durations.base, motion.gentleSpring),
        },
      },
    },
    MuiTypography: {
      styleOverrides: {
        root: {
          transition: transition(['color', 'opacity'], motion.durations.fast, motion.softOut),
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          transition: transition(['box-shadow', 'background-color', 'border-color', 'transform'], motion.durations.base, motion.softOut),
        },
      },
    },
    MuiSkeleton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
        },
      },
    },
    MuiTooltip: {
      defaultProps: {
        // MUI 桌面端默认 enterDelay 为 0；应用统一采用短暂停留后显示。
        enterDelay: 450,
        enterNextDelay: 0,
      },
      styleOverrides: {
        tooltip: {
          borderRadius: 12,
        },
      },
    },
    MuiBadge: {
      styleOverrides: {
        badge: {
          borderRadius: 999,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme }) => ({
          borderRadius: 10,
          border: '1px solid',
          borderColor: theme.palette.divider,
          backgroundColor: theme.palette.dialog.main,
          backgroundImage: 'none',
        }),
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: theme.palette.dialog.main,
        }),
      },
    },
    MuiDialogContent: {
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: theme.palette.dialog.main,
        }),
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: theme.palette.dialog.main,
        }),
      },
    },
    MuiSelect: {
      defaultProps: {
        variant: 'outlined',
      },
    },
    MuiFormControl: {
      styleOverrides: {
        root: {
          transition: transition(['opacity'], motion.durations.fast, motion.softOut),
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          transition: transition(['color', 'transform'], motion.durations.fast, motion.softOut),
        },
      },
    },
    MuiFormLabel: {
      styleOverrides: {
        asterisk: ({ theme }) => ({
          color: theme.palette.error.main,
        }),
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          borderRadius: 999,
        },
      },
    },
    MuiCircularProgress: {
      styleOverrides: {
        root: {
          transition: 'opacity 160ms ease',
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: {
          minHeight: 56,
        },
      },
    },
    MuiAccordionDetails: {
      styleOverrides: {
        root: {
          paddingTop: 0,
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          borderRadius: '10px 10px 0 0',
          backdropFilter: 'blur(24px) saturate(1.16)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.16)',
        },
      },
    },
  },
};

export const createAppTheme = (mode: ResolvedMode, primaryColor: string = '#5B6CFF', presetId?: string | null) => {
  const { scheme } = resolveScheme(mode, presetId, primaryColor);
  return createTheme({
    ...baseTheme,
    palette: {
      mode,
      primary: {
        main: scheme.primary,
      },
      secondary: {
        main: scheme.secondary,
      },
      warning: {
        main: scheme.accent,
      },
      background: {
        default: scheme.background,
        paper: scheme.paper,
      },
      text: {
        primary: scheme.text,
        secondary: scheme.textSecondary,
      },
      divider: scheme.divider,
      action: {
        hover: scheme.actionHover,
        selected: scheme.actionHover,
      },
      surface: {
        main: scheme.surface,
      },
      dialog: {
        main: scheme.dialog,
      },
      selection: {
        main: scheme.selection,
      },
      backgroundImage: scheme.bodyBackground,
      menuShadow: scheme.menuShadow,
    },
  });
};

declare module '@mui/material/styles' {
  interface Palette {
    surface: Palette['primary'];
    dialog: Palette['primary'];
    selection: Palette['primary'];
    backgroundImage: string;
    menuShadow: string;
  }
  interface PaletteOptions {
    surface?: PaletteOptions['primary'];
    dialog?: PaletteOptions['primary'];
    selection?: PaletteOptions['primary'];
    backgroundImage?: string;
    menuShadow?: string;
  }
}
