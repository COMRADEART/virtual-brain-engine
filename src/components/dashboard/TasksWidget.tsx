import { useState } from "react";
import { useLocalStorage } from "../../engine/useApiCall";

interface Task {
  id: string;
  title: string;
  done: boolean;
}

const DEFAULT_TASKS: Task[] = [
  { id: '1', title: 'Neural topology mapped', done: true },
  { id: '2', title: 'System-Brain integration', done: true },
  { id: '3', title: 'Calibrate focus-depth', done: false },
  { id: '4', title: 'Expand long-term cortex', done: false }
];

export function TasksWidget() {
  // Persisted so directives survive a reload (client-side only — these are the
  // user's notes, not server state).
  const [tasks, setTasks] = useLocalStorage<Task[]>("brain-dashboard-tasks", DEFAULT_TASKS);
  const [newTask, setNewTask] = useState("");

  const addTask = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && newTask.trim()) {
      setTasks((prev) => [...prev, { id: Date.now().toString(), title: newTask.trim(), done: false }]);
      setNewTask("");
    }
  };

  const toggleTask = (id: string) => {
    setTasks((prev) => prev.map(t => t.id === id ? { ...t, done: !t.done } : t));
  };

  return (
    <div className="dashboard-widget tasks-widget">
      <header className="widget-header">
        <h3 className="widget-title">Engine Directives</h3>
      </header>
      <div className="widget-body">
        <div className="task-input-wrapper">
          <input 
            type="text" 
            className="task-input" 
            placeholder="ADD NEW DIRECTIVE..." 
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={addTask}
          />
        </div>
        <ul className="task-list">
          {tasks.map(task => (
            <li key={task.id} className={`task-item ${task.done ? 'done' : ''}`} onClick={() => toggleTask(task.id)}>
              <div className="task-checkbox">{task.done && '✓'}</div>
              <span className="task-text">{task.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
