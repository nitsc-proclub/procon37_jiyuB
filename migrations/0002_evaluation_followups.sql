CREATE TABLE IF NOT EXISTS evaluation_followups (
  generation_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  final_preference_selection TEXT CHECK (
    final_preference_selection IS NULL OR
    final_preference_selection IN ('candidate-a', 'candidate-b', 'neither')
  ),
  subject_feedback_choice TEXT CHECK (
    subject_feedback_choice IS NULL OR
    subject_feedback_choice IN ('primary', 'alternate-1', 'alternate-2', 'other')
  ),
  subject_feedback_label TEXT,
  rating_drawing_song_quality TEXT CHECK (
    rating_drawing_song_quality IS NULL OR
    rating_drawing_song_quality IN ('good', 'okay', 'needs-work')
  ),
  rating_drawing_order_clarity TEXT CHECK (
    rating_drawing_order_clarity IS NULL OR
    rating_drawing_order_clarity IN ('good', 'okay', 'needs-work')
  ),
  rating_child_friendliness TEXT CHECK (
    rating_child_friendliness IS NULL OR
    rating_child_friendliness IN ('good', 'okay', 'needs-work')
  ),
  rating_singability TEXT CHECK (
    rating_singability IS NULL OR
    rating_singability IN ('good', 'okay', 'needs-work')
  ),
  FOREIGN KEY (generation_id) REFERENCES evaluation_records(generation_id) ON DELETE CASCADE,
  CHECK (
    final_preference_selection IS NOT NULL OR
    subject_feedback_choice IS NOT NULL OR
    rating_drawing_song_quality IS NOT NULL OR
    rating_drawing_order_clarity IS NOT NULL OR
    rating_child_friendliness IS NOT NULL OR
    rating_singability IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS evaluation_followups_updated_at
  ON evaluation_followups (updated_at);
