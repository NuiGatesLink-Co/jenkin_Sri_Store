import { test, expect } from '@playwright/test';

test.describe('Taskflow API E2E Suite', () => {
  let createdTaskId: string | number;

  test('1. list tasks', async ({ request }) => {
    // Spec 1: list tasks
    const res = await request.get('https://jsonplaceholder.typicode.com/todos?_limit=5');
    expect(res.status()).toBe(200);
    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBeTruthy();
    expect(tasks.length).toBeGreaterThan(0);
  });

  test('2. create task', async ({ request }) => {
    // Spec 2: create task
    const res = await request.post('https://jsonplaceholder.typicode.com/todos', {
      data: {
        title: 'Playwright Automated E2E Task (Lab 05)',
        completed: false,
        userId: 1,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.title).toBe('Playwright Automated E2E Task (Lab 05)');
    createdTaskId = body.id;
  });

  test('3. mark task done', async ({ request }) => {
    // Spec 3: mark task done
    const res = await request.patch('https://jsonplaceholder.typicode.com/todos/1', {
      data: {
        completed: true,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(true);
  });
});
