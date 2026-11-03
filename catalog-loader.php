<?php
header('Cache-Control: no-store');
$revision = hash_file('sha256', __DIR__ . '/catalog.js');
header('Location: /catalog.js?v=' . $revision, true, 302);
