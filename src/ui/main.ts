import { mount } from 'svelte';
import App from './app/App.svelte';
import './app/theme.css';

mount(App, { target: document.getElementById('app')! });
