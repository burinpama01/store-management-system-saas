import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useSearchKeyboard() {
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const listeners = [
      Keyboard.addListener('keyboardWillShow', () => setVisible(true)),
      Keyboard.addListener('keyboardDidShow', () => setVisible(true)),
      Keyboard.addListener('keyboardWillHide', () => setVisible(false)),
      Keyboard.addListener('keyboardDidHide', () => setVisible(false)),
    ];
    return () => listeners.forEach(listener => listener.remove());
  }, []);
  return { active: focused && (Platform.OS === 'web' || visible), focus: () => setFocused(true), blur: () => setFocused(false) };
}
