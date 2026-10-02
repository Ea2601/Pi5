import { registerRootComponent } from 'expo';
// Arka plan görevi tanımı uygulama yüklenirken yapılmalı (sistem görevi uygulama kapalıyken de başlatır)
import './src/platform/task.ts';
import App from './App.tsx';

registerRootComponent(App);
