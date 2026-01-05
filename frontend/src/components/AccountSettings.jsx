import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { User, Mail, Lock, Save, Plus, Trash2, Edit2, Shield, Unlock } from 'lucide-react';

const AccountSettings = () => {
    // Auth State
    const [isUnlocked, setIsUnlocked] = useState(false);
    const [unlockPassword, setUnlockPassword] = useState('');

    // Tab State
    const [activeTab, setActiveTab] = useState('profile');

    // Profile State
    const [formData, setFormData] = useState({
        username: 'admin',
        email: 'admin@visionguard.ai',
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
    });

    // User Management State
    const [users, setUsers] = useState([
        { id: 1, username: 'operator1', email: 'op1@visionguard.ai', role: 'Operator', status: 'Active' },
        { id: 2, username: 'viewer', email: 'view@visionguard.ai', role: 'Viewer', status: 'Inactive' },
    ]);
    const [isUserModalOpen, setIsUserModalOpen] = useState(false);
    const [editingUser, setEditingUser] = useState(null);
    const [userForm, setUserForm] = useState({ username: '', email: '', role: 'Operator', password: '' });

    // --- Handlers: Unlock ---
    const handleUnlock = (e) => {
        e.preventDefault();
        if (unlockPassword === 'admin') {
            setIsUnlocked(true);
        } else {
            alert("Incorrect password. Try 'admin'.");
        }
    };

    // --- Handlers: Profile ---
    const handleProfileChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleProfileSubmit = (e) => {
        e.preventDefault();
        alert("Account details updated successfully (Mock)");
    };

    // --- Handlers: User Management ---
    const handleUserInputChange = (e) => {
        const { name, value } = e.target;
        setUserForm(prev => ({ ...prev, [name]: value }));
    };

    const openAddUserModal = () => {
        setEditingUser(null);
        setUserForm({ username: '', email: '', role: 'Operator', password: '' });
        setIsUserModalOpen(true);
    };

    const openEditUserModal = (user) => {
        setEditingUser(user);
        setUserForm({ username: user.username, email: user.email, role: user.role, password: '' }); // Password usually blank on edit
        setIsUserModalOpen(true);
    };

    const deleteUser = (id) => {
        if (window.confirm('Are you sure you want to delete this user?')) {
            setUsers(prev => prev.filter(u => u.id !== id));
        }
    };

    const saveUser = (e) => {
        e.preventDefault();
        if (editingUser) {
            // Edit
            setUsers(prev => prev.map(u => u.id === editingUser.id ? { ...u, ...userForm, status: u.status } : u));
        } else {
            // Add
            const newUser = { id: Date.now(), ...userForm, status: 'Active' };
            setUsers(prev => [...prev, newUser]);
        }
        setIsUserModalOpen(false);
    };


    // --- Render: Locked State ---
    if (!isUnlocked) {
        return (
            <div className="max-w-md mx-auto mt-20">
                <Card>
                    <CardHeader className="text-center">
                        <div className="mx-auto bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center mb-4">
                            <Lock className="w-6 h-6 text-primary" />
                        </div>
                        <CardTitle>Authentication Required</CardTitle>
                        <CardDescription>Please enter your password to access account settings.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleUnlock} className="space-y-4">
                            <input
                                type="password"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                placeholder="Enter Password"
                                value={unlockPassword}
                                onChange={(e) => setUnlockPassword(e.target.value)}
                            />
                            <Button type="submit" className="w-full">
                                <Unlock className="w-4 h-4 mr-2" /> Unlock Settings
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // --- Render: Unlocked State ---
    return (
        <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Account Settings</h1>
                    <p className="text-muted-foreground">Manage your profile and system users.</p>
                </div>
            </div>

            {/* Tabs Navigation */}
            <div className="flex space-x-1 rounded-lg bg-muted p-1 w-fit">
                <button
                    onClick={() => setActiveTab('profile')}
                    className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${activeTab === 'profile' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/50 hover:text-foreground'}`}
                >
                    My Profile
                </button>
                <button
                    onClick={() => setActiveTab('users')}
                    className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${activeTab === 'users' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/50 hover:text-foreground'}`}
                >
                    User Management
                </button>
            </div>

            {/* Profile Content */}
            {activeTab === 'profile' && (
                <Card>
                    <CardHeader>
                        <CardTitle>Profile Information</CardTitle>
                        <CardDescription>Update your account's profile information and email address.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleProfileSubmit} className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Username</label>
                                    <div className="relative">
                                        <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="text"
                                            name="username"
                                            value={formData.username}
                                            onChange={handleProfileChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Email Address</label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="email"
                                            name="email"
                                            value={formData.email}
                                            onChange={handleProfileChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="pt-4 border-t">
                                <h3 className="mb-4 text-lg font-medium">Security</h3>
                                <div className="space-y-4 max-w-md">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">Current Password</label>
                                        <div className="relative">
                                            <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                            <input
                                                type="password"
                                                name="currentPassword"
                                                value={formData.currentPassword}
                                                onChange={handleProfileChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">New Password</label>
                                        <div className="relative">
                                            <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                            <input
                                                type="password"
                                                name="newPassword"
                                                value={formData.newPassword}
                                                onChange={handleProfileChange}
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="flex justify-end">
                                <Button type="submit">
                                    <Save className="w-4 h-4 mr-2" /> Save Changes
                                </Button>
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            {/* User Management Content */}
            {activeTab === 'users' && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle>User Management</CardTitle>
                            <CardDescription>Manage access and roles for other users.</CardDescription>
                        </div>
                        <Button onClick={openAddUserModal} className="flex gap-2">
                            <Plus className="w-4 h-4" /> Add User
                        </Button>
                    </CardHeader>
                    <CardContent>
                        <div className="rounded-md border">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/50 border-b">
                                    <tr>
                                        <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Username</th>
                                        <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Email</th>
                                        <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Role</th>
                                        <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Status</th>
                                        <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map(user => (
                                        <tr key={user.id} className="border-b transition-colors hover:bg-muted/50">
                                            <td className="p-4 align-middle font-medium flex items-center gap-2">
                                                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                                                    <User className="w-4 h-4" />
                                                </div>
                                                {user.username}
                                            </td>
                                            <td className="p-4 align-middle">{user.email}</td>
                                            <td className="p-4 align-middle">
                                                <div className="flex items-center gap-1">
                                                    <Shield className="w-3 h-3 text-primary" />
                                                    {user.role}
                                                </div>
                                            </td>
                                            <td className="p-4 align-middle">
                                                <span className={`px-2 py-1 rounded-full text-xs ${user.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>
                                                    {user.status}
                                                </span>
                                            </td>
                                            <td className="p-4 align-middle text-right">
                                                <div className="flex justify-end gap-2">
                                                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditUserModal(user)}>
                                                        <Edit2 className="w-4 h-4" />
                                                    </Button>
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteUser(user.id)}>
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Add/Edit User Modal Mockup */}
            {isUserModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <Card className="w-full max-w-md">
                        <CardHeader>
                            <CardTitle>{editingUser ? 'Edit User' : 'Add New User'}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <form onSubmit={saveUser} className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Username</label>
                                    <input
                                        name="username"
                                        value={userForm.username}
                                        onChange={handleUserInputChange}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Email</label>
                                    <input
                                        type="email"
                                        name="email"
                                        value={userForm.email}
                                        onChange={handleUserInputChange}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Role</label>
                                    <select
                                        name="role"
                                        value={userForm.role}
                                        onChange={handleUserInputChange}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    >
                                        <option>Admin</option>
                                        <option>Operator</option>
                                        <option>Viewer</option>
                                    </select>
                                </div>
                                {!editingUser && (
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">Password</label>
                                        <input
                                            type="password"
                                            name="password"
                                            value={userForm.password}
                                            onChange={handleUserInputChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                            required={!editingUser}
                                        />
                                    </div>
                                )}
                                <div className="flex justify-end gap-2 pt-2">
                                    <Button type="button" variant="ghost" onClick={() => setIsUserModalOpen(false)}>Cancel</Button>
                                    <Button type="submit">Save User</Button>
                                </div>
                            </form>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
};

export default AccountSettings;
