import { describe, it, expect } from 'vitest';
import { suiteAppUrl } from './suiteApps';

// v1.22 (limecore#131) — links into StudyDesk and LimeLog use their exact
// route URLs, and only the routes they accept.

const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

describe('suiteAppUrl', () => {
  it('builds StudyDesk links (StudyDesk#297 routes)', () => {
    expect(suiteAppUrl('studydesk', 'plan')).toBe('com.studydesk.app://open/plan');
    expect(suiteAppUrl('studydesk', 'today')).toBe('com.studydesk.app://open/today');
    expect(suiteAppUrl('studydesk', `course/${ID}`)).toBe(`com.studydesk.app://open/course/${ID}`);
  });

  it('builds LimeLog links', () => {
    expect(suiteAppUrl('limelog', 'today')).toBe('com.limecore.workouttracker://open/today');
    expect(suiteAppUrl('limelog', 'progress')).toBe('com.limecore.workouttracker://open/progress');
    expect(suiteAppUrl('limelog', `workout/${ID}`)).toBe(`com.limecore.workouttracker://open/workout/${ID}`);
  });

  it('refuses routes the apps do not accept, and ids that are not UUIDs', () => {
    expect(suiteAppUrl('studydesk', 'settings')).toBeNull();
    expect(suiteAppUrl('studydesk', 'course/not-a-uuid')).toBeNull();
    expect(suiteAppUrl('studydesk', `course/${ID}/../x`)).toBeNull();
    expect(suiteAppUrl('limelog', 'plan')).toBeNull();
  });
});
